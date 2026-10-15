# Specification: Runtime-neutral DummyJSON client with a Forge adapter

<!-- cspell:ignore dummyjson -->

This document is a standalone implementation handoff for the
`@forge-ahead/dummyjson` library. It requires no other project documents,
conversation history, or access to a consuming application's repository.

## Problem Statement

Consumers want to use the same typed, GET-only DummyJSON client in a Forge
backend and in browser applications. The current implementation couples
otherwise reusable request handling to the Forge backend runtime.

The inspected package identifies itself as version `0.2.0` and exposes
`createDummyJSONClient()`, `fetchRawPage()`, and `createRemainingPages()`.
Its client implementation:

- Imports the default API object from `@forge/api` at module scope.
- Always performs HTTP requests through that object's `fetch` method.
- Uses `openapi-fetch` and generated endpoint types internally.
- Returns `Result` values with `ProblemDetails` errors from
  `@forge-ahead/errors` rather than exposing raw HTTP responses.
- Restricts request origins to `https://dummyjson.com`.
- Removes per-request overrides for `baseUrl`, `fetch`, `Request`,
  `parseAs`, and `method`.
- Declares `@forge/api` as a required peer dependency.

Consequently, importing the shared client pulls Forge backend code into
consumers that do not run inside that backend. A consumer also cannot supply
its own transport. The limitation is not inherent to DummyJSON or
`openapi-fetch`.

These observations describe the inspected artifact, not an assumption that
the target library checkout remains unchanged. Reconcile them with the
current source before implementing.

## Solution

Separate the runtime-neutral client from its Forge transport adapter.
The shared client accepts an explicitly supplied fetch transport. A separate
Forge entry point supplies the existing Forge fetch behavior automatically.

| Consumer | Public import | Factory behavior |
| --- | --- | --- |
| Browser or other fetch-capable runtime | `@forge-ahead/dummyjson` | `createDummyJSONClient(transport)` requires a transport |
| Forge backend | `@forge-ahead/dummyjson/forge` | `createDummyJSONClient()` supplies the Forge transport |

Both clients retain the same typed `GET` methods, successful data shapes,
error contract, and DummyJSON-origin restrictions. Existing pagination and
queue-continuation helpers remain available without requiring Forge at
runtime.

Browser support means compatibility with browser fetch and browser bundling;
it does not bypass browser CORS, Forge permissions, or sandbox limitations.
In particular, this change does not promise direct external HTTP access from
native Forge UI Kit. A UI Kit application can continue invoking a backend
resolver that uses the Forge adapter.

## User Stories

1. As a browser application developer, I want to import the shared client
   without loading Forge backend code, so that browser bundling succeeds.
2. As a browser application developer, I want to supply browser fetch, so
   that the typed client can make requests in a normal browser environment.
3. As a Forge backend developer, I want a dedicated zero-configuration
   adapter, so that requests continue using Forge's supported fetch API.
4. As a library consumer, I want identical endpoint typing across transports,
   so that switching runtimes does not change request or response contracts.
5. As a library consumer, I want successful requests to return the existing
   `Result` success value, so that existing result-handling logic still works.
6. As a library consumer, I want HTTP, network, and response-parsing failures
   to preserve the existing structured error contract, so that failures are
   handled consistently.
7. As a library consumer, I want the client to retain its GET-only API and
   fixed DummyJSON origin, so that transport configuration does not expose
   arbitrary destinations or HTTP methods.
8. As a test author, I want to provide a deterministic fake transport, so
   that client behavior can be tested without Forge or live network access.
9. As a pagination-helper consumer, I want to use existing helpers without
   importing Forge, so that value-based pagination remains reusable.
10. As a browser application maintainer, I want to install the package without
    installing `@forge/api`, so that backend-only dependencies are optional.
11. As an existing Forge consumer, I want explicit migration guidance, so
    that the new import path is discoverable and the API change is not silent.
12. As a TypeScript consumer, I want published declarations to resolve under
    supported compiler configurations, so that the packed library works
    beyond its own source checkout.
13. As a package maintainer, I want both existing ESM and CommonJS distribution
    formats preserved, so that this refactor does not also force a module-format
    migration.
14. As an application developer, I want the runtime and permission limitations
    stated accurately, so that I do not mistake browser compatibility for
    permission to call external services from every Forge UI surface.

## Implementation Decisions

### Shared client and transport boundary

- The shared factory is `createDummyJSONClient(transport)`. Its required
  transport accepts the constructed standard `Request` and asynchronously
  returns a standard `Response`, matching the installed `openapi-fetch`
  custom-fetch contract.
- There is no default transport in the shared factory and no automatic
  detection of Forge versus browser execution. The caller chooses transport
  explicitly. A browser caller can supply a wrapper around browser fetch.
- Transport selection occurs once, at client construction. Per-request
  transport replacement remains unsupported.
- Preserve the existing typed `GET` interface and generated endpoint types.
  Preserve the default base URL, query/path serialization, JSON parsing,
  `Result` behavior, and HTTP-status handling.
- Keep the origin check in the shared request path before invoking the
  supplied transport. Keep stripping the existing prohibited per-request
  overrides, including when a caller bypasses TypeScript checking.
- The injected transport is trusted application configuration, not untrusted
  request input. The client validates the initial request destination; it
  does not claim to control a malicious transport or all redirect behavior.
- Shared modules and their transitive runtime imports must not depend on
  `@forge/api`, Forge backend initialization, or Node-only built-ins.
- Do not require browser consumers to install Node-specific ambient types
  solely to compile public declarations. Use fetch-compatible public types
  that work in supported browser and server TypeScript environments.
- Inspect existing dependencies for browser compatibility. Address an actual
  incompatibility if found; do not replace working dependencies speculatively.

### Forge adapter

- The Forge entry point exports a zero-argument factory named
  `createDummyJSONClient` that delegates to the shared factory.
- Only this adapter imports `@forge/api`. Preserve the existing translation
  from a standard `Request` into the URL and Forge fetch options, including
  HTTP method, headers, and abort signal. Do not assume Forge fetch accepts
  a standard `Request` directly if the current implementation adapts it.
- The adapter preserves Forge's managed request behavior. It does not bypass
  authorization, runtime policies, or egress enforcement.
- The shared entry point must not re-export the Forge adapter, even if the
  bundler might otherwise remove unused code.

### Package surface and compatibility

- Add a public `@forge-ahead/dummyjson/forge` package export with matching
  runtime artifacts and type declarations for supported ESM and CommonJS
  consumers. Preserve existing unrelated public exports.
- Mark the `@forge/api` peer dependency optional. Forge applications using the
  adapter must still declare and install a compatible `@forge/api` version.
- Treat the changed root factory signature as a breaking API change. Record
  it in release notes and apply the library's existing versioning policy.
- Document two migrations: existing Forge callers change their import to the
  Forge entry point; browser or generic-runtime callers use the root entry
  point and provide a transport. Do not silently substitute global fetch in
  existing Forge applications.
- Preserve `fetchRawPage`, `createRemainingPages`, and their behavior. Their
  queue abstraction remains caller-supplied; no new Forge queue dependency
  is introduced.
- Limit changes to the transport boundary, adapter, package exports and
  dependency metadata, focused tests, and consumer documentation.

### Runtime and permission documentation

- Browser requests remain subject to CORS and the host's content security
  policy. No credentials or secrets belong in browser configuration.
- Forge backend applications must declare DummyJSON in
  `permissions.external.fetch.backend`.
- Forge Custom UI applications making browser-side requests must declare the
  domain in `permissions.external.fetch.client`, in addition to satisfying
  browser CORS requirements.
- Native UI Kit consumers should use a backend resolver where direct browser
  networking is unavailable. The client refactor alone does not change that.
- Permission changes, deployment, and installation belong to consuming apps,
  not to this library's implementation task.

## Testing Decisions

Tests assert externally observable behavior, not private helper names,
internal call ordering, or snapshots of implementation details.

The primary seam is the public shared-client factory with an injected fake
fetch transport. Adapter and packaged-entry-point checks supplement that
seam only where runtime and packaging isolation cannot be proven through it.

The inspected installed artifact did not include the library's test sources.
Locate and extend existing client and package-validation tests in the target
library checkout; no particular test file or framework layout is assumed.

### Required acceptance checks

1. A successful typed products request returns the same successful `Result`
   data as before and reaches the injected transport with the expected GET
   URL, query parameters, and request headers.
2. The factory does not invoke the transport until a request is made.
3. HTTP failures, rejected fetch calls, empty responses, and malformed JSON
   preserve the existing error behavior. When a response status is known,
   preserve the existing status information in the error result.
4. Constructing two clients with different transports keeps their requests
   isolated; transport configuration is not global mutable state.
5. Attempts to override the base URL, transport, request constructor, parsing
   mode, or HTTP method cannot bypass the existing restrictions. Test runtime
   inputs as well as TypeScript restrictions.
6. Any request whose resolved initial origin is not `https://dummyjson.com`
   is rejected before the transport runs. Exercise the existing origin guard
   through the public API where possible rather than exporting a test helper.
7. The Forge adapter uses Forge fetch with the same URL, method, headers, and
   abort-signal mapping as before, and returns the shared client's results.
   Substitute Forge fetch in tests; do not require deployment or credentials.
8. A browser-targeted bundle importing and using only the shared client
   succeeds without Forge packages or Node-only polyfills. Inspect resolved
   dependencies to verify that no Forge backend module is included.
9. Importing and exercising pagination helpers from the root entry point does
   not initialize Forge. Existing helper tests continue to pass unchanged.
10. A consumer fixture can install and use the packed shared package without
    installing `@forge/api`. Do not rely only on the library's development
    dependency tree, which may hide a required-peer regression.
11. Supported ESM and CommonJS imports and their type declarations resolve
    from the packed artifact for both public entry points. Include a browser
    type-check fixture without Node ambient types.
12. Existing library checks pass. New tests are deterministic and offline;
    live DummyJSON availability is not part of the required test suite.

Completion requires implementation, focused regression tests, package
validation, release/migration notes, and passing existing project checks.
Report commands run and any unresolved environment limitations.

## Out of Scope

- Implementing a Jira product picker or changing any consuming application.
- Jira field storage, numeric-ID validation, rendering, or submission logic.
- Adding new DummyJSON endpoints, write methods, authentication, or secrets.
- Replacing `Result`, changing error schemas, or regenerating the API contract
  unless a demonstrated compatibility issue makes it necessary.
- Reworking pagination, adding caches, retries, queues, or background jobs.
- Switching UI Kit applications to Custom UI.
- Framework-specific frontend hooks or components.
- Publishing a release, deploying a Forge app, installing an app, or changing
  any live environment without separate authorization.

## Further Notes

The motivation is a product-selection application that needs typed DummyJSON
product data while retaining numeric product IDs as its stored values. That
application is context only; no access to it is required to implement this
library change.

This handoff selects an explicit shared transport plus a separate Forge
adapter. It does not request automatic runtime detection, conditional browser
exports, or duplicated client implementations.

External documentation for verification:

- [openapi-fetch client configuration](https://openapi-ts.dev/openapi-fetch/api)
- [Forge basic fetch client](https://developer.atlassian.com/platform/forge/runtime-reference/fetch-api-basic/)
- [Forge external permissions](https://developer.atlassian.com/platform/forge/manifest-reference/permissions/)
- [DummyJSON products API](https://dummyjson.com/docs/products)

All necessary requirements are included above. No relative links, local
workspace paths, issue identifiers, or companion documents are prerequisites.
