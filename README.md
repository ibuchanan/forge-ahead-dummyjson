# @forge-ahead/dummyjson

A default client for the [DummyJSON API](https://dummyjson.com/), shared by concrete Atlassian Forge examples so each example does not need to reimplement common client logic.

## Development

Use [Bun](https://bun.sh) 1.4 or newer. The package itself targets Node.js
22+ at runtime for consumers of the published package; Bun is all you need
for development here:

```sh
bun install
bun run check
```

Run `bun run build` to build without the full check suite. See
[DEVELOPMENT.md](DEVELOPMENT.md) for the development workflow, explicit
contract regeneration, and Forge host egress and queue wiring.

## DummyJSON

DummyJSON provides a free, public REST API for example and demo applications. See the [DummyJSON documentation](https://dummyjson.com/docs) for available endpoints and response shapes.

## License

Apache-2.0. See [LICENSE](LICENSE).
