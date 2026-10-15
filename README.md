# @forge-ahead/dummyjson

A typed, GET-only [DummyJSON](https://dummyjson.com/) client for browsers,
fetch-capable servers, and Atlassian Forge backends. Requests return
`Result<data, ProblemDetails>` from `@forge-ahead/errors`; request failures
return errors without retrying automatically.

## Install and use

```sh
bun add github:ibuchanan/forge-ahead-dummyjson
```

### Browser or generic fetch runtime

The root factory requires a transport accepting a standard `Request` and
returning `Promise<Response>`. It never selects a transport automatically:

```ts
import { createDummyJSONClient } from "@forge-ahead/dummyjson";

const client = createDummyJSONClient((request) => globalThis.fetch(request));
const result = await client.GET("/products", {
  params: { query: { limit: 10, select: "id,title" } },
});
if (result.isOk()) {
  console.log(result.value.products);
} else {
  console.error(result.error);
}
```

Requests are GET-only and initially restricted to `https://dummyjson.com`.
Per-request host, transport, request constructor, parsing mode, and method
overrides are not supported. The transport is trusted application
configuration; this restriction does not control a malicious transport or
all redirects. No credentials or secrets belong in browser configuration.
Browser requests remain subject to CORS and the host's content security policy.

### Forge backend

Install a compatible `@forge/api` (`^8.2.0`) in the consuming app and use the
separate adapter, which preserves Forge's managed fetch and egress behavior:

```ts
import { createDummyJSONClient } from "@forge-ahead/dummyjson/forge";

const result = await createDummyJSONClient().GET("/products");
```

Declare `https://dummyjson.com` in the host manifest's
`permissions.external.fetch.backend`. Forge Custom UI making browser-side
requests uses the **root** client and must instead declare
`permissions.external.fetch.client`, while also satisfying CORS. Native UI Kit
does not gain direct external networking from this library; use a backend
resolver where browser networking is unavailable. Deployment, installation,
and permissions remain the consuming app's responsibility.

### Migrate from 0.2.x

This is a breaking API change:

- **Existing Forge callers:** change the factory import from
  `@forge-ahead/dummyjson` to `@forge-ahead/dummyjson/forge`; keep the
  zero-argument factory call and host `@forge/api` installation.
- **Browser or other runtimes:** import from the root and supply a transport,
  as above. `@forge/api` is an optional peer and is not needed for root imports.

`fetchRawPage`, `createRemainingPages`, and their types remain available from
the root without Forge. The former preserves raw collection items and reported
page metadata; the latter plans and enqueues remaining offsets through a
caller-supplied queue. See [host queue wiring](DEVELOPMENT.md#wire-a-consuming-forge-app)
for continuation, delivery, and idempotency requirements.

Both entry points ship ESM and CommonJS JavaScript and declarations. Browser
consumers need standard fetch APIs; server consumers target Node.js 22+.

## Development

Use [Bun](https://bun.sh) 1.4 or newer:

```sh
bun install
bun run check
```

Run `bun run build` to build without the full check suite. See
[DEVELOPMENT.md](DEVELOPMENT.md) for explicit contract regeneration and package
validation, and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.
The [DummyJSON documentation](https://dummyjson.com/docs) describes endpoints
and response shapes.

## License

Apache-2.0. See [LICENSE](LICENSE).
