import { fetch } from "@forge/api";
import { createDummyJSONClient as createClient } from "./index";

/** Create a GET-only DummyJSON client using Forge backend fetch. */
export function createDummyJSONClient(): ReturnType<typeof createClient> {
  return createClient(async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
    });
    // Forge implements the response methods used by openapi-fetch but declares a narrower type.
    return response as unknown as Response;
  });
}
