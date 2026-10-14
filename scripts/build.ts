import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "SDK build failed");
const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
await Bun.write(new URL("../dist/storesdz-sdk.min.js", import.meta.url), bytes);
await Bun.write(
  new URL("../dist/storesdz-sdk.min.js.sha256", import.meta.url),
  `${digest}  storesdz-sdk.min.js\n`,
);

console.log(`Built ${bytes.length} bytes of minified browser JavaScript.`);
