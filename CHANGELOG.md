## Unreleased

**Contributor/operational note:** the dev toolchain (build, test, lint, and
script execution) migrated from tsdown + Vitest + npm to Bun. This does
not change the package's public API, published artifact shape, or
runtime behavior for consumers — verified with `publint`,
`@arethetypeswrong/cli`, and a pure-Node consumer smoke test — so it is
not reflected as a version bump. See [DEVELOPMENT.md](DEVELOPMENT.md) for
the updated contributor workflow.

## What's Changed in 0.1.0
* NONE Split src into lib/scripts and build scripts via tsdown
* NONE Verify consumers and host wiring
* NONE Enqueue offset pages with resume support
* NONE Plan remaining offset pages
* NONE Add resource-neutral raw page helper
* NONE Add typed Forge Result GET client
* NONE Record generation and client specification
* NONE Pin DummyJSON source submodule
* NONE Add reviewed DummyJSON OpenAPI contract

