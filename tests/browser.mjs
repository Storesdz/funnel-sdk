import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";

const sdk = readFileSync(
  new URL("../dist/storesdz-sdk.min.js", import.meta.url),
);
const server = createServer((request, response) => {
  if (request.url === "/sdk.js") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(sdk);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${origin}; connect-src 'none'; base-uri 'none'; form-action 'none'"><script src="${origin}/sdk.js"></script><a href="#order">Order</a><section id="order">Form placeholder</section>`;
  response.end(`<!doctype html><title>Local SDK fixture</title><body><script>
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts allow-forms';
    addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'storesdz-sdk-ready') return;
      const channel = new MessageChannel();
      channel.port1.onmessage = ({data}) => {
        if (!['quote', 'delivery', 'checkout'].includes(data.method)) return;
        channel.port1.postMessage({id: data.id, ok: true, data:
          data.method === 'checkout' ? {number: 'FAKE-ONLY', total: '100'} :
          data.method === 'delivery' ? [{type: 'home', cost: '20'}] : {subtotal: '100', quantity: data.input.quantity ?? 1}
        });
      };
      frame.contentWindow.postMessage({type: 'storesdz-sdk-init', session: event.data.session, context: {version: 1, store: {name: 'Fixture'}}}, '*', [channel.port2]);
    });
    frame.srcdoc = ${JSON.stringify(document).replace(/</g, "\\u003c")};
    document.body.append(frame);
  </script>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector("iframe");
  const frame = page.frames().find((item) => item.parentFrame());
  await frame.waitForFunction(() => !!window.StoresDZ);
  assert.deepEqual(await frame.evaluate(() => StoresDZ.ready()), {
    version: 1,
    store: { name: "Fixture" },
  });
  assert.deepEqual(
    await frame.evaluate(() => StoresDZ.quote({ quantity: 2 })),
    { subtotal: "100", quantity: 2 },
  );
  assert.deepEqual(
    await frame.evaluate(() => StoresDZ.delivery({ wilaya: "16" })),
    [{ type: "home", cost: "20" }],
  );
  assert.equal(
    (await frame.evaluate(() => StoresDZ.checkout({}))).number,
    "FAKE-ONLY",
  );
  const isolation = await frame.evaluate(async () => {
    let parentBlocked = false,
      storageBlocked = false,
      networkBlocked = false;
    try {
      void parent.document.body;
    } catch {
      parentBlocked = true;
    }
    try {
      localStorage.getItem("test");
    } catch {
      storageBlocked = true;
    }
    try {
      await fetch("http://127.0.0.1");
    } catch {
      networkBlocked = true;
    }
    return { parentBlocked, storageBlocked, networkBlocked };
  });
  assert.deepEqual(isolation, {
    parentBlocked: true,
    storageBlocked: true,
    networkBlocked: true,
  });
  await frame.locator("a").click();
  assert.equal(await frame.evaluate(() => document.activeElement.id), "order");
  assert.equal(page.frames().length, 2);
  assert.equal(await frame.evaluate(() => Object.isFrozen(StoresDZ)), true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: compiled SDK, browser bridge, sandbox isolation, and fragment navigation (fake host only).",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
