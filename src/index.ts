import createClient from "openapi-fetch";

/** Create an openapi-fetch client for DummyJSON, optionally typed with generated API paths. */
export function createDummyJSONClient<Paths extends object = object>() {
  return createClient<Paths>({ baseUrl: "https://dummyjson.com" });
}
