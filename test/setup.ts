import { mock } from "bun:test";

/**
 * Registered before any test file loads (see bunfig.toml `test.preload`), so
 * the Forge adapter resolves this mock instead of initializing the backend.
 * Shared-client and pagination tests do not use this transport.
 */
export const forgeFetchMock =
  mock<(url: string | URL, init?: RequestInit) => Promise<Response>>();

mock.module("@forge/api", () => ({ fetch: forgeFetchMock }));
