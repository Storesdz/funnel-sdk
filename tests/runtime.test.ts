import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const source = readFileSync(
  new URL("../dist/storesdz-sdk.min.js", import.meta.url),
  "utf8",
);
const windows: Window[] = [];
type Sdk = {
  ready(): Promise<unknown>;
  quote(input?: unknown): Promise<unknown>;
  delivery(input: unknown): Promise<unknown>;
  checkout(input: unknown): Promise<unknown>;
  loadScript(url: string): Promise<void>;
  loadStyle(url: string): Promise<void>;
  loadLibrary(name: string): Promise<void>;
};

function runtime() {
  const window = new Window({
    url: "https://frame.test",
    // Evaluate only the local SDK artifact; remote scripts and merchant code never enter this VM.
    settings: {
      enableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  windows.push(window);
  const parent = { postMessage: mock() };
  Object.defineProperty(window, "parent", { value: parent });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  Object.defineProperty(window, "setTimeout", {
    value: (callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
  });
  Object.defineProperty(window, "clearTimeout", {
    value: (id: number) => timers.delete(id),
  });
  window.eval(source);
  const sdk = (window as unknown as { StoresDZ: Sdk }).StoresDZ;
  const session = parent.postMessage.mock.calls[0][0].session;
  const port = {
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    postMessage: mock(),
  };
  function initialize(
    context: unknown = { version: 1 },
    origin = parent,
    token = session,
  ) {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: origin as unknown as Window,
        data: { type: "storesdz-sdk-init", session: token, context },
        ports: [
          port as unknown as InstanceType<
            typeof window.MessageEvent
          >["ports"][number],
        ],
      }),
    );
  }
  const resources: any[] = [];
  window.document.head.append = (...elements) => {
    resources.push(...elements);
  };
  return { window, parent, sdk, port, initialize, timers, resources };
}

function directRuntime() {
  const window = new Window({
    url: "https://shop.storesdz.com/f/offer",
    settings: {
      enableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  windows.push(window);
  window.document.head.innerHTML =
    '<script type="application/json" id="storesdz-funnel-context">{"slug":"offer","context":{"version":1,"store":{"name":"Fixture"}}}</script>';
  const fetch = mock(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ ok: true, data: { subtotal: "100" } })),
  );
  Object.defineProperty(window, "fetch", { value: fetch });
  window.eval(source);
  const sdk = (window as unknown as { StoresDZ: Sdk }).StoresDZ;
  return { window, sdk, fetch };
}

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

test("distribution is minified, contains no source map, and matches its checksum", () => {
  expect(source.length).toBeLessThan(10000);
  expect(source).not.toContain("sourceMappingURL");
  expect(source).not.toContain("function installSdk");
  const hash = createHash("sha256").update(source).digest("hex");
  expect(
    readFileSync(
      new URL("../dist/storesdz-sdk.min.js.sha256", import.meta.url),
      "utf8",
    ),
  ).toBe(`${hash}  storesdz-sdk.min.js\n`);
});

test("direct documents initialize immediately and use only the same-origin uncached HTTP SDK", async () => {
  const { sdk, fetch, window } = directRuntime();
  expect(await sdk.ready()).toEqual({ version: 1, store: { name: "Fixture" } });
  expect(await sdk.quote({ quantity: 2 })).toEqual({ subtotal: "100" });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("/api/storefront/v1/funnels/offer/sdk/quote");
  expect(init).toMatchObject({
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    body: '{"quantity":2}',
  });
  expect(init.headers).not.toHaveProperty("Authorization");
  window.document.body.innerHTML = '<a href="/products">Store</a>';
  const click = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  window.document.querySelector("a")!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
});

test("direct checkout prevents parallel and repeated orders and retains known rejection codes", async () => {
  const { sdk, fetch } = directRuntime();
  fetch.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({ code: "OUT_OF_STOCK", message: "Unavailable" }),
        { status: 400 },
      ),
  );
  await expect(sdk.checkout({})).rejects.toMatchObject({
    code: "OUT_OF_STOCK",
  });
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const checkout = sdk.checkout({});
  await expect(sdk.checkout({})).rejects.toMatchObject({
    code: "CHECKOUT_PENDING",
  });
  finish(
    new Response(JSON.stringify({ ok: true, data: { number: "FAKE-ONLY" } })),
  );
  expect(await checkout).toEqual({ number: "FAKE-ONLY" });
  await expect(sdk.checkout({})).rejects.toMatchObject({
    code: "ORDER_CONFIRMED",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("direct checkout locks after transport failures or malformed responses, without retrying", async () => {
  for (const outcome of ["transport", "malformed", "unknown"]) {
    const { sdk, fetch } = directRuntime();
    fetch.mockImplementationOnce(async () => {
      if (outcome === "transport") throw new Error("Network failed");
      return outcome === "malformed"
        ? new Response("bad json")
        : new Response(JSON.stringify({ code: "INTERNAL_ERROR" }), {
            status: 500,
          });
    });
    await expect(sdk.checkout({})).rejects.toMatchObject({
      code: "CHECKOUT_UNCERTAIN",
    });
    await expect(sdk.checkout({})).rejects.toMatchObject({
      code: "CHECKOUT_UNCERTAIN",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test("direct requests retain the concurrency limit and reject circular inputs before sending", async () => {
  const { sdk, fetch } = directRuntime();
  const circular: any = {};
  circular.self = circular;
  await expect(sdk.quote(circular)).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  });
  expect(fetch).toHaveBeenCalledTimes(0);
  const finishes: ((response: Response) => void)[] = [];
  fetch.mockImplementation(
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  const requests = Array.from({ length: 8 }, () => sdk.quote());
  await expect(sdk.quote()).rejects.toMatchObject({
    code: "TOO_MANY_REQUESTS",
  });
  for (const finish of finishes)
    finish(new Response(JSON.stringify({ ok: true, data: {} })));
  await Promise.all(requests);
});

test("only the parent with the matching session can initialize the private port", async () => {
  const { sdk, initialize, port, window } = runtime();
  let initialized = false;
  sdk.ready().then(() => {
    initialized = true;
  });
  initialize({ wrong: true }, { postMessage: mock() });
  initialize({ wrong: true }, undefined, "wrong-session");
  await Promise.resolve();
  expect(initialized).toBe(false);
  const context = { version: 1, store: { name: "Fixture" } };
  initialize(context);
  expect(await sdk.ready()).toEqual(context);
  expect(typeof port.onmessage).toBe("function");
  expect(Object.isFrozen(sdk)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(window, "StoresDZ")?.writable).toBe(
    false,
  );
});

test("commerce promises correlate responses by ID and preserve host error codes", async () => {
  const { sdk, initialize, port } = runtime();
  initialize();
  const quote = sdk.quote({ quantity: 2 });
  const delivery = sdk.delivery({ wilaya: "16" });
  await Promise.resolve();
  const [a, b] = port.postMessage.mock.calls.map((call) => call[0]);
  expect(a).toMatchObject({ method: "quote", input: { quantity: 2 } });
  expect(b).toMatchObject({ method: "delivery", input: { wilaya: "16" } });
  port.onmessage!({ data: { id: b.id, ok: true, data: ["home"] } });
  port.onmessage!({
    data: {
      id: a.id,
      ok: false,
      error: { code: "OUT_OF_STOCK", message: "Unavailable" },
    },
  });
  expect(await delivery).toEqual(["home"]);
  await expect(quote).rejects.toMatchObject({
    code: "OUT_OF_STOCK",
    message: "Unavailable",
  });
});

test("limits pending requests and marks checkout timeouts as uncertain", async () => {
  const { sdk, initialize, timers, port } = runtime();
  initialize();
  const requests = Array.from({ length: 8 }, () => sdk.quote());
  await Promise.resolve();
  await expect(sdk.quote()).rejects.toMatchObject({
    code: "TOO_MANY_REQUESTS",
  });
  for (const call of port.postMessage.mock.calls)
    port.onmessage!({ data: { id: call[0].id, ok: true, data: {} } });
  await Promise.all(requests);
  const checkout = sdk.checkout({});
  await Promise.resolve();
  const timeout = [...timers.values()].find((timer) => timer.delay === 75000)!;
  timeout.callback();
  await expect(checkout).rejects.toMatchObject({ code: "CHECKOUT_UNCERTAIN" });
  const quote = sdk.quote();
  await Promise.resolve();
  [...timers.values()].find((timer) => timer.delay === 30000)!.callback();
  await expect(quote).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});

test("unserializable requests reject and free their pending slot", async () => {
  const { sdk, initialize, port, timers } = runtime();
  initialize();
  port.postMessage.mockImplementation(() => {
    throw new Error("DataCloneError");
  });
  await expect(sdk.quote({ callback() {} })).rejects.toMatchObject({
    code: "INVALID_REQUEST",
  });
  expect(timers.size).toBe(0);
});

test("fragment links remain inside the document and focus encoded targets", () => {
  const { window } = runtime();
  window.document.body.innerHTML =
    '<a href="#order%20section"><span>Order</span></a><section id="order section"></section>';
  const target = window.document.querySelector("section")!;
  target.scrollIntoView = mock();
  const event = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  window.document.querySelector("span")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(window.document.activeElement).toBe(target);
  for (const href of ["#missing", "#bad%"]) {
    window.document.querySelector("a")!.setAttribute("href", href);
    const click = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    window.document.querySelector("a")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  }
});

test("resource loaders reject unsafe URLs, deduplicate, and retry failed loads", async () => {
  const { sdk, window, resources } = runtime();
  for (const url of [
    "http://cdn.test/a.js",
    "/a.js",
    "javascript:alert(1)",
    "https://user:secret@cdn.test/a.js",
  ])
    expect(await sdk.loadScript(url).catch((error) => error.code)).toBe(
      "INVALID_RESOURCE_URL",
    );
  const first = sdk.loadScript("https://cdn.test/a.js");
  const second = sdk.loadScript("https://cdn.test/a.js#same");
  expect(resources.length).toBe(1);
  resources[0].onload();
  await Promise.all([first, second]);
  const failed = sdk.loadStyle("https://cdn.test/a.css");
  const rejection = failed.catch((error) => error.code);
  resources[1].onerror();
  expect(await rejection).toBe("RESOURCE_LOAD_FAILED");
  const retry = sdk.loadStyle("https://cdn.test/a.css");
  resources[2].onload();
  await retry;
  expect(await sdk.loadLibrary("toString").catch((error) => error.code)).toBe(
    "UNKNOWN_LIBRARY",
  );
});

test("pinned libraries load scripts/styles and timed-out resources can be retried", async () => {
  const { sdk, window, resources, timers } = runtime();
  const bootstrap = sdk.loadLibrary("bootstrap");
  expect(resources.map((resource) => resource.src || resource.href)).toEqual([
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js",
  ]);
  for (const resource of resources) resource.onload();
  await bootstrap;
  const failed = sdk.loadLibrary("jquery");
  const rejection = failed.catch((error) => error.code);
  [...timers.values()].find((timer) => timer.delay === 15000)!.callback();
  expect(await rejection).toBe("RESOURCE_LOAD_FAILED");
  const retry = sdk.loadLibrary("jquery");
  resources.at(-1).onload();
  await retry;
});
