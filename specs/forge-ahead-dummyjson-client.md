# Specification: `@forge-ahead/dummyjson`

## Purpose

Build a general-purpose, read-only DummyJSON client for Forge backend consumers. It is not an Assets import adapter: an initial consumer may import products, while another may populate Jira custom fields. Neither consumer's mapping or submission logic belongs in this package.

This specification supersedes the earlier product-import handoff. The current `createDummyJSONClient` implementation is a stub and may be replaced; its existing behavior is not a compatibility constraint. `specs/discourse.ts` supplied a two-layer design example, not an interface to copy verbatim.

## Delivery gate: prove the OpenAPI generation workflow first

**Phase 1 is a tooling spike. Stop after reporting its findings; do not implement the full client until the route-discovery approach has passed review.**

- Use the checked-out, commit-pinned `vendor/DummyJSON` submodule as the primary source. Its `src/routes/index.js` mounts the resource routers, and its `database/*.json` files contain records for the eight families below.
- Test `swagger-autogen` (or a better tool if it fails) to discover paths, methods, path/query parameters, nested routes, and aliases from the Express source. Compare generated routes against an independently extracted inventory of **every unauthenticated GET route** under products, users, carts, posts, comments, todos, recipes, and quotes. Include the singular and plural router aliases and cross-resource paths in those routers; exclude GETs requiring authentication, non-JSON/utility routes, and all mutations. Do not silently patch missing routes by hand: if the tool misses any, report the gaps and try a different automated approach.
- Test `quicktype` against the eight pinned `vendor/DummyJSON/database/*.json` datasets to generate draft JSON Schemas. Demonstrate usable resource drafts and report obvious limitations; **full correctness for every query-dependent response variant is not a spike pass condition**. Do not copy dataset records (especially user records containing `password` or `ssn`) into the spec, fixtures, generated examples, or logs.
- Deliver a short spike report with the pinned submodule commit, tool/version/commands tried, expected-versus-discovered GET-route inventory and gaps, schema draft results and limitations, and a recommendation for the reproducible generation workflow. **Complete unauthenticated GET-route discovery is the hard pass/fail criterion**; do not declare the spike passed on a subset.

## Contract generation after the spike

1. Keep a concrete, reviewed OpenAPI document in this repository. An explicit regeneration command should draft it using the selected tools and the pinned `vendor/DummyJSON` checkout. Do not regenerate it on install, build, or test; do not make routine development depend on the live API. Live GETs may be used as optional validation, not as the primary schema source.
2. Include the public read-only JSON GET routes for all eight families, including details, searches, category/tag/filter routes, random routes, and cross-resource routes where unauthenticated. Model response envelopes and endpoint-specific response shapes to the extent supported by generated evidence, then review the draft; document uncertainty rather than asserting that sampled fields are universally required. This is not a demand that the spike perfectly infer every `select`-dependent shape.
3. Generate TypeScript endpoint types from the committed OpenAPI document using `openapi-typescript` (already a dev dependency). A deterministic regeneration/verification check should reveal drift between the reviewed contract and generated types. The committed contract, not live responses or private app source, is the input for normal type generation.

## Library interface and behavior

### Typed Forge HTTP layer

- Replace the stub with a package-root `createDummyJSONClient()` for `https://dummyjson.com`. Its public operation is typed, **GET-only**, and each request returns `Promise<Result<endpointData, ProblemDetails>>` using `@forge-ahead/errors` types and helpers. Preserve the path-specific request parameters and response type inferred from the OpenAPI document. Do not expose a raw, throwing `openapi-fetch` request path as a second public client interface.
- Use Forge backend external HTTP via `api.fetch` from `@forge/api`, not global `fetch` or `requestJira`. An internal wrapper around the existing `openapi-fetch` dependency can convert HTTP errors, network failures, and JSON/decoding errors to `Result.err`. Preserve HTTP status in `ProblemDetails` when available, including 429, so callers can decide about retries. Do not turn failure into an empty successful page or silently retry.
- No network work or queue work at import time. No authentication is required for the covered public GETs. The host app declares `https://dummyjson.com` backend egress in its own Forge manifest; the library cannot grant it.
- Build JavaScript and declarations for both ESM and CommonJS consumers, including Forge apps using webpack/ts-loader with `module: "CommonJS"` and `moduleResolution: "Node"`. Choose the `@forge/api` dependency/peer declaration to reflect its host-provided Forge runtime relationship. Keep the generic Result wrapper internal to this package; do not extract another package on the strength of one implementation.

### Resource-neutral page layer

- Provide a generic helper accepting a caller-supplied `fetchPage({ skip, limit })` that returns a `Result` and an item selector for the endpoint's array key (`products`, `users`, etc.). On success expose `{ records, total, skip, limit }` containing **raw** DummyJSON items and server-reported metadata. Forward errors as `Result.err`. The lower-level typed GET still returns the untouched endpoint response.
- The helper must not project to Assets records, Jira custom fields, or other consumer-specific data. Avoid public named methods that merely forward to a single typed GET; add resource-specific methods only when they perform real reusable work.

### Pure remaining-page planner

- Given the **already fetched and processed first page's** reported `total`, `skip`, and effective `limit`, calculate offsets for the remaining pages. Do not schedule the first page again. Use reported metadata, not the requested limit: DummyJSON can return an effective limit different from the request (including `limit=0` meaning all records).
- The planner is pure and independent of Forge and HTTP. It must terminate, avoid duplicate first-page offsets, handle no remaining pages, and reject invalid or non-advancing page metadata (in particular `limit=0` while a page remains before `total`). Validate arithmetic inputs sufficiently to avoid unsafe/non-terminating offsets. Use the package's Result error convention for expected invalid-input failures.

### Opt-in Forge Async Events enqueue helper

- Accept a host-supplied queue via a narrow structural `push(events)` interface compatible with the verified `@forge/events` `Queue.push` signature, plus a caller-supplied function that builds each `{ body: Record<string, unknown> }` event from a page offset and limit. The host can supply a fake queue in tests. Do not instantiate `Queue` or require `@forge/events` at runtime in this package.
- Push remaining-page events in groups of **at most 50**. Require a caller-supplied positive `maxEvents` budget; when reached, return a next offset so the host can persist and resume in another invocation. Do not assume this per-call budget enforces Forge's installation-wide rate limit (500 events per minute). Do not sleep, throttle, automatically retry, or schedule a continuation. The host should keep event bodies within Forge's **200 KB per push** limit; do not claim a page-offset helper can guarantee arbitrary caller-supplied body sizes.
- Return success and failure through the `@forge-ahead/errors`-compatible Result interface. On a failed or partially successful `push`, stop and report confirmed completed batches, the failed batch's offsets, any `failedEvents` details available, and which acceptance outcomes remain **unknown**. Do not present uncertain offsets as definitely unqueued or blindly re-push a batch. The host decides persistence, resumption, retries, consumer behavior, and idempotent writes; Forge delivery may be at least once.
- The host, not the library, defines the queue name and consumer handler in `manifest.yml`, sets up the consumer function, determines retry policy, and processes or writes records. Document the host wiring requirement without adding a manifest or an app to this repository.

## Verification and handoff

- Offline tests mock Forge fetch and cover path/query typing, successful decoding, HTTP-status propagation, network/parse failures, and absence of implicit retries. Normal tests must not make live HTTP requests.
- Test the page helper with different collection array keys and raw values; test first-page exclusion, reported/effective limit, completed and empty ranges, and invalid/non-advancing metadata. Test enqueue chunking, `maxEvents`/resume, a structurally compatible fake queue, full and partial push failures, uncertain acceptance, and absence of automatic retry.
- Demonstrate typed package-root imports in a CommonJS/Node-resolution Forge-like consumer; run typecheck, unit tests, build, and package check. Document explicit regeneration, Forge egress and queue wiring, delivery/idempotency assumptions, and the library/host responsibilities.

## Out of scope

No Assets or Jira field mapping, flat product import records, host-specific adapter interface, queue consumer factory, authentication or write endpoints, UI, cache, runtime validation of arbitrary DummyJSON JSON, generic cross-API package, automatic retry/pacing, automatic submodule updates, or live-API dependency in the default build/test workflow. The page/queue helpers cover DummyJSON-style offset pages; they are not a claim that OpenAPI prescribes pagination.
