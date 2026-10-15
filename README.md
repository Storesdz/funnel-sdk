# StoresDZ funnel SDK

The standalone browser runtime for merchant-built StoresDZ funnel pages.
It supports direct HTML pages from the Rust funnel server and the existing
sandboxed iframe bridge. Direct pages receive a public JSON context and call the
same-origin HTTP SDK endpoint. Product identity, current publication, authoritative
prices, funnel attribution, terms, delivery and attempt IDs remain server-validated.

## CDN

```html
<script src="https://cdn.jsdelivr.net/gh/Storesdz/funnel-sdk@v1.2.0/dist/storesdz-sdk.min.js"></script>
```

In storefrontnext set:

```text
STOREFRONT_FUNNEL_SDK_URL=https://cdn.jsdelivr.net/gh/Storesdz/funnel-sdk@v1.2.0/dist/storesdz-sdk.min.js
```

The storefront loads the script before merchant code; merchants do not need to
add another script tag. Pin an exact release tag or commit. The bundle is
minified with shortened identifiers, without source maps or runtime dependencies.
Minification does not protect secrets. The public repository contains readable
source. The Rust server also serves this exact pinned bundle at
`/f/_assets/storesdz-sdk-v1.2.0.min.js`, cached for five minutes.

Direct documents include a non-executable `script#storesdz-funnel-context` JSON
block containing `{slug, context}` before the SDK script. With no parent frame,
the SDK initializes immediately and posts to
`/api/storefront/v1/funnels/{slug}/sdk/{quote|delivery|checkout}`. Requests omit
cookies, cannot redirect and are never cached. Normal links perform full browser
navigation back to the storefront router. Direct merchant scripts execute on the
store's origin; only the legacy iframe mode provides sandbox origin isolation.

## API

- `StoresDZ.ready()` returns public `{version, store, product, checkout, policies}`.
- `StoresDZ.quote({variantId?, quantity?, currency?})` returns a fresh quote.
- `StoresDZ.delivery({variantId?, quantity?, currency?, wilaya})` returns available delivery options.
- `StoresDZ.checkout({variantId?, quantity?, currency?, customer, address?, shippingMethod, termsAccepted, couponCode?})` returns the order receipt.
- `StoresDZ.loadLibrary('jquery' | 'bootstrap')` loads pinned CDN libraries.
- `StoresDZ.loadScript(url)` / `loadStyle(url)` load absolute HTTPS resources without URL credentials.

All methods return promises. Errors contain `code` and `message`. Inputs and
results for commerce calls follow the storefront host's v1 contract. The host
selects the linked product; callers cannot supply product/funnel IDs, prices,
or checkout attempt IDs. After `CHECKOUT_UNCERTAIN` or `CHECKOUT_PENDING`, ask the
buyer to contact the store before ordering again; do not automatically retry.

Resource loads are deduplicated; failures or 15-second timeouts permit retry.
The bridge allows eight pending requests. Quote/delivery time out after 30
seconds; checkout times out after 75 seconds and reports an uncertain result.
Fragment links scroll and focus inside the isolated document.

## Development and releases

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
bunx playwright install chromium
bun run test:browser
bun run format:check
bun run pack
```

Unit tests execute the compiled bundle, including handshake validation, request
limits, errors/timeouts, resource loaders, and fragment navigation. Chrome tests
use a local fake host and verify sandbox isolation, SDK calls, and navigation;
they never create live orders. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an
installed local Chrome executable.

The generated `dist` files are committed so jsDelivr can serve release tags.
CI rebuilds and rejects stale artifacts, runs all checks and browser tests,
and uploads the minified bundle, SHA-256 checksum, and package tarball.
For a release, bump `package.json`, rebuild and commit `dist`, then push the
matching `v<version>` tag. The tag workflow publishes a GitHub release only after
verification succeeds. GitHub-hosted jsDelivr delivery needs no npm token.
