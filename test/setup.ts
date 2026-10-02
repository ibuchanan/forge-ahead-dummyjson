import { mock } from "bun:test";

/**
 * Registered before any test file loads (see bunfig.toml `test.preload`), so
 * static `import api from "@forge/api"` in test files and src/index.ts
 * resolves to this mock instead of the real (unpublished) package.
 */
export const forgeFetchMock =
  mock<(url: string | URL, init?: RequestInit) => Promise<Response>>();

mock.module("@forge/api", () => ({ default: { fetch: forgeFetchMock } }));
