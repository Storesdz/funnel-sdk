// The direct HTML renderer supplies public context; all commerce validation stays on the server.
export function directTransport() {
  const marker = document.getElementById("storesdz-funnel-context");
  if (window.parent !== window || !marker) return;
  const { slug, context } = JSON.parse(marker.textContent || "null");
  if (
    typeof slug !== "string" ||
    !slug ||
    slug.length > 255 ||
    /^[.]{1,2}$/.test(slug) ||
    /[/\\?#\u0000-\u001f]/.test(slug) ||
    context?.version !== 1
  )
    throw new Error("Invalid StoresDZ funnel context.");
  const endpoint = `/api/storefront/v1/funnels/${encodeURIComponent(slug)}/sdk/`;
  let active = 0;
  let checkout: "idle" | "pending" | "confirmed" | "uncertain" = "idle";
  const rejected = new Set([
    "INVALID_REQUEST",
    "INVALID_SELECTION",
    "INVALID_CURRENCY",
    "TERMS_REQUIRED",
    "DELIVERY_REQUIRED",
    "INVALID_DELIVERY",
    "INVALID_FUNNEL_ITEMS",
    "FUNNEL_NOT_FOUND",
    "COMMERCE_REJECTED",
    "COMMERCE_BUSY",
    "OUT_OF_STOCK",
  ]);
  const failure = (code: string, message: string) =>
    Object.assign(new Error(message), { code });
  return {
    context,
    async call(method: string, input: unknown) {
      if (active >= 8)
        throw failure("TOO_MANY_REQUESTS", "Wait for pending SDK requests.");
      if (method === "checkout" && checkout !== "idle")
        throw failure(
          checkout === "confirmed"
            ? "ORDER_CONFIRMED"
            : checkout === "pending"
              ? "CHECKOUT_PENDING"
              : "CHECKOUT_UNCERTAIN",
          checkout === "confirmed"
            ? "Your order is already confirmed."
            : "Contact the store before ordering again.",
        );
      let body: string;
      try {
        let analytics: unknown;
        if (method === "checkout") {
          try {
            analytics = (
              window as unknown as { StoresDZAnalytics?: () => unknown }
            ).StoresDZAnalytics?.();
          } catch {}
        }
        body = JSON.stringify(
          analytics &&
            input &&
            typeof input === "object" &&
            !Array.isArray(input)
            ? { ...input, analytics }
            : input,
        );
      } catch {
        throw failure(
          "INVALID_REQUEST",
          "SDK requests must contain serializable data.",
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        method === "checkout" ? 75000 : 30000,
      );
      if (method === "checkout") checkout = "pending";
      active++;
      try {
        const response = await fetch(endpoint + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || result?.ok !== true)
          throw failure(
            result?.code || "SERVICE_UNAVAILABLE",
            result?.message || "The store is temporarily unavailable.",
          );
        if (method === "checkout") checkout = "confirmed";
        return result.data;
      } catch (error) {
        if (method === "checkout") {
          const code =
            error instanceof Error && "code" in error ? String(error.code) : "";
          checkout = rejected.has(code) ? "idle" : "uncertain";
          if (checkout === "uncertain")
            throw failure(
              "CHECKOUT_UNCERTAIN",
              "The order could not be confirmed. Contact the store before ordering again.",
            );
        }
        if (error instanceof Error && "code" in error) throw error;
        throw failure(
          "SERVICE_UNAVAILABLE",
          "The store did not respond. Please try again.",
        );
      } finally {
        active--;
        clearTimeout(timer);
      }
    },
  };
}
