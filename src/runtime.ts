// The CDN bundle installs this runtime inside the storefront's isolated document.
export function installSdk() {
  let port: MessagePort;
  const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let initialize: (context: unknown) => void;
  const ready = new Promise((resolve) => {
    initialize = resolve;
  });
  // srcdoc fragment URLs resolve against the storefront URL, so handle them within this document.
  document.addEventListener("click", (event) => {
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = link?.getAttribute("href");
    if (event.defaultPrevented || !href?.startsWith("#")) return;
    event.preventDefault();
    if (href === "#") {
      window.scrollTo({ top: 0 });
      return;
    }
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    if (
      !target.matches("a[href],button,input,select,textarea,summary,[tabindex]")
    )
      target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  });
  const resources = new Map<string, Promise<void>>();
  function loadResource(
    kind: "script" | "style",
    value: string,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
      url.hash = "";
    } catch {
      return Promise.reject(
        Object.assign(
          new Error("Use an absolute HTTPS library URL without credentials."),
          {
            code: "INVALID_RESOURCE_URL",
          },
        ),
      );
    }
    const key = kind + ":" + url.href;
    const previous = resources.get(key);
    if (previous) return previous;
    const request = new Promise<void>((resolve, reject) => {
      const element =
        kind === "script"
          ? document.createElement("script")
          : document.createElement("link");
      if (element instanceof HTMLScriptElement) {
        element.src = url.href;
        element.async = false;
      } else {
        element.rel = "stylesheet";
        element.href = url.href;
      }
      const fail = () => {
        clearTimeout(timer);
        resources.delete(key);
        element.remove();
        reject(
          Object.assign(
            new Error(
              "Could not load the library. Check its HTTPS URL, CDN availability, and CORS policy.",
            ),
            { code: "RESOURCE_LOAD_FAILED" },
          ),
        );
      };
      const timer = setTimeout(fail, 15000);
      element.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      element.onerror = fail;
      document.head.append(element);
    });
    resources.set(key, request);
    return request;
  }
  const libraries: Record<string, { scripts: string[]; styles: string[] }> = {
    jquery: {
      scripts: ["https://code.jquery.com/jquery-4.0.0.min.js"],
      styles: [],
    },
    bootstrap: {
      scripts: [
        "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js",
      ],
      styles: [
        "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css",
      ],
    },
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data?.type === "storesdz-sdk-ping") {
      parent.postMessage({ type: "storesdz-sdk-ready", session }, "*");
      return;
    }
    if (
      event.data?.type !== "storesdz-sdk-init" ||
      event.data.session !== session ||
      !event.ports[0] ||
      port
    )
      return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      const request = pending.get(data?.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(data.id);
      if (data.ok) request.resolve(data.data);
      else
        request.reject(
          Object.assign(new Error(data.error.message), {
            code: data.error.code,
          }),
        );
    };
    initialize(event.data.context);
  });
  async function call(method: string, input: unknown = {}) {
    await ready;
    if (pending.size >= 8)
      throw Object.assign(new Error("Too many pending SDK requests."), {
        code: "TOO_MANY_REQUESTS",
      });
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(
            Object.assign(
              new Error(
                method === "checkout"
                  ? "Contact the store before ordering again."
                  : "The store did not respond. Please try again.",
              ),
              {
                code:
                  method === "checkout"
                    ? "CHECKOUT_UNCERTAIN"
                    : "SERVICE_UNAVAILABLE",
              },
            ),
          );
        },
        method === "checkout" ? 75000 : 30000,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ id, method, input });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(
          Object.assign(
            new Error("SDK requests must contain serializable data."),
            {
              code: "INVALID_REQUEST",
            },
          ),
        );
      }
    });
  }
  Object.defineProperty(window, "StoresDZ", {
    value: Object.freeze({
      ready: () => ready,
      quote: (input?: unknown) => call("quote", input),
      delivery: (input: unknown) => call("delivery", input),
      checkout: (input: unknown) => call("checkout", input),
      loadScript: (url: string) => loadResource("script", url),
      loadStyle: (url: string) => loadResource("style", url),
      loadLibrary: async (name: string) => {
        const library = Object.hasOwn(libraries, name)
          ? libraries[name]
          : undefined;
        if (!library)
          throw Object.assign(
            new Error(
              "Unknown library. Use jquery, bootstrap, or a custom HTTPS URL with loadScript/loadStyle.",
            ),
            { code: "UNKNOWN_LIBRARY" },
          );
        await Promise.all([
          ...library.styles.map((url) => loadResource("style", url)),
          ...library.scripts.map((url) => loadResource("script", url)),
        ]);
      },
    }),
  });
  parent.postMessage({ type: "storesdz-sdk-ready", session }, "*");
}
