# Development

This guide covers the local development loop for `@forge-ahead/dummyjson`. The package provides shared DummyJSON client logic for concrete Forge examples.

## Setup

Use Node.js 22 or newer and npm:

```sh
npm install
npm run build
```

## Common Scripts

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `npm run build`         | Build the package with `tsdown`.                               |
| `npm run dev`           | Rebuild with `tsdown --watch`.                                  |
| `npm run check`         | Run formatting, lint, TypeScript, tests, and the production build. |
| `npm run format`        | Format files with Biome.                                       |
| `npm run lint:fix`      | Apply Biome lint fixes.                                        |
| `npm test`              | Run the Vitest test suite once.                                |
| `npm run test:watch`    | Run Vitest in watch mode.                                      |
| `npm run test:coverage` | Run Vitest with coverage reporting.                            |
| `npm run changelog`     | Generate changelog output with `git-cliff`.                    |

## Maintenance

Keep the package focused on reusable DummyJSON client behavior used by Forge examples. Document public exports and usage in the README when the client API is established or changed. Keep Forge-specific example behavior in the consuming examples rather than coupling it into the shared API client.

### Refresh the reviewed API contract

Initialize the pinned source with
`git submodule update --init vendor/DummyJSON`. Keep it at the reviewed
commit recorded by the repository gitlink; review upstream changes and the
route inventory before deliberately updating that pin. Run `npm run build`
so `scripts/generate-contract.mjs` and `scripts/check-generated.mjs` are
current, then `npm run generate:contract` to draft
`specs/dummyjson.openapi.json` from the pinned routes and local datasets.
Review its diff (especially optional fields
and sensitive user data), then run `npm run generate:types` to update
`src/lib/generated.ts`. Commit reviewed changes to both files and run
`npm run contract:check`. Routine builds and checks do **not** regenerate the
contract or call the live API. See
[contract generation](specs/contract-generation.md) for review criteria.

### Wire a consuming Forge app

The library exports typed read-only `createDummyJSONClient().GET` (Forge
backend `api.fetch`, `Result` errors), `fetchRawPage`, `planRemainingPages`,
and opt-in `enqueueRemainingPages`. The host must install the package and
`@forge/api`, call the client from backend code, and declare backend egress in
**its own** `manifest.yml`:

```yaml
permissions:
  external:
    fetch:
      backend:
        - address: https://dummyjson.com
```

For asynchronous pages, the host must install `@forge/events`, create a
`Queue` with its own key, and wire the matching consumer and handler in
**its own** manifest. For example, adapt these names and handler path to the
host:

```yaml
modules:
  consumer:
    - key: dummyjson-consumer
      queue: dummyjson-pages
      function: dummyjson-worker
  function:
    - key: dummyjson-worker
      handler: consumer.handler
```

The host fetches and processes the **first** page itself. Pass its reported
`total`, `skip`, and effective `limit` to `planRemainingPages`; do not enqueue
that page again. Use `fetchRawPage` for remaining pages and map/write records
inside the host, not this package.

Supply `enqueueRemainingPages` with the host's queue, event builder, and a
positive `maxEvents` per invocation. It pushes at most 50 offsets per `push`;
the host must additionally stay within Forge's 200 KB per-push payload limit
and 500 events/minute installation-wide rate limit. A successful `nextOffset`
is a cursor for host-persisted resumption. On error, reconcile
`completedBatches`, `failedBatch`, and `uncertainOffsets` before using
`nextUnattemptedOffset` to resume unattempted pages. Never assume a failed
push accepted zero events.

Queue delivery is at least once: make the host consumer's writes idempotent
and own retry policy, rate pacing, checkpoint persistence, and any
continuation invocation. The package does not configure permissions, queue
consumers, Assets/Jira mappings, or retries.

Run `npm run build && npm run test:consumer` to check the CommonJS/Node
package-root consumer and ESM/CommonJS entries without a live API call.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
