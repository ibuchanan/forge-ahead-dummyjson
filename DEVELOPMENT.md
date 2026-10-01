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

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
