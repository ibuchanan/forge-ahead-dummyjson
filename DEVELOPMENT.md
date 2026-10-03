# Development

This guide covers the local development loop for `@forge-ahead/dummyjson`. The package provides shared DummyJSON client logic for concrete Forge examples.

## Setup

Use [Bun](https://bun.sh) 1.4 or newer. The package targets Node.js 22+ at
runtime for consumers of the published package, but Bun is all you need for
development here:

```sh
bun install
bun run build
```

## Common Scripts

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `bun run build`         | Build the package with `scripts/build.ts` (Bun bundler for `dist/*.mjs`/`dist/*.cjs`, `tsc` for declarations). |
| `bun run dev`           | Rebuild on change with `bun --watch scripts/build.ts`.                 |
| `bun run check`         | Run formatting, lint, TypeScript, tests, and the production build. |
| `bun run format`        | Format files with Biome.                                       |
| `bun run lint:fix`      | Apply Biome lint fixes.                                        |
| `bun test`              | Run the `bun test` suite once.                                 |
| `bun run test:watch`    | Run `bun test` in watch mode.                                  |
| `bun run test:coverage` | Run `bun test` with coverage reporting.                        |
| `bun run changelog`     | Generate changelog output with `git-cliff`.                    |

## Maintenance

Keep the package focused on reusable DummyJSON client behavior used by Forge examples. Document public exports and usage in the README when the client API is established or changed. Keep Forge-specific example behavior in the consuming examples rather than coupling it into the shared API client.

### Refresh the reviewed API contract

Initialize the pinned source with
`git submodule update --init vendor/DummyJSON`. Keep it at the reviewed
commit recorded by the repository gitlink and `specs/reviewed-routes.json`;
review upstream changes and the route inventory before deliberately updating
that pin. Run
`bun run generate:contract` to draft `specs/dummyjson.openapi.json` from the
pinned routes and local datasets.
Review its diff (especially optional fields
and sensitive user data), then run `bun run generate:types` to update
`src/generated.ts`. Commit reviewed changes to both files and run
`bun run contract:check`. This read-only command reports source-attestation,
route-semantic, and generated-type drift. Routine builds and checks do **not**
run contract verification, regenerate the contract, or call the live API. See
[contract generation](specs/contract-generation.md) for review criteria.

### Wire a consuming Forge app

The library exports typed read-only `createDummyJSONClient().GET` (Forge
backend `api.fetch`, `Result` errors), `fetchRawPage`, and opt-in
`createRemainingPages`. The host must install the package and `@forge/api`,
call the client from backend code, and declare backend egress in **its own**
`manifest.yml`:

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
`total`, `skip`, and effective `limit` to `createRemainingPages`; do not enqueue
that page again. Use `fetchRawPage` for remaining pages and map/write records
inside the host, not this package.

`createRemainingPages` returns a `Result`; on success its value exposes
`enqueue` and `resume`. Supply `enqueue` with the host's queue, event builder,
and a positive `maxEvents` per invocation. It pushes at most 50 offsets per
`push`; the host must additionally stay within Forge's 200 KB per-push payload
limit and 500 events/minute installation-wide rate limit. A successful
`nextOffset` is a cursor for host-persisted resumption. To continue, pass that
persisted cursor value to `resume`, which validates it against the plan before
enqueueing. On error, reconcile `completedBatches`, `failedBatch`, and
`uncertainOffsets` before using `nextUnattemptedOffset` to resume unattempted
pages. Never assume a failed push accepted zero events.

Queue delivery is at least once: make the host consumer's writes idempotent
and own retry policy, rate pacing, checkpoint persistence, and any
continuation invocation. The package does not configure permissions, queue
consumers, Assets/Jira mappings, or retries.

Run `bun run pack:check` to verify the packed file list plus `package.json`
shape (`publint`) and that declaration files resolve correctly under every
module-resolution mode a consumer might use (`@arethetypeswrong/cli`).

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
