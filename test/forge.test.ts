import { beforeEach, expect, it } from "bun:test";
import { createDummyJSONClient } from "../src/forge";
import { forgeFetchMock } from "./setup";

beforeEach(() => forgeFetchMock.mockReset());

it("adapts a standard request to Forge fetch without making a request at construction", async () => {
  forgeFetchMock.mockResolvedValue(Response.json({ id: 42, title: "Desk" }));
  const controller = new AbortController();
  const client = createDummyJSONClient();
  expect(forgeFetchMock).not.toHaveBeenCalled();
  const result = await client.GET("/products/{id}", {
    params: { path: { id: 42 }, query: { select: "title" } },
    headers: { "X-Example": "forge" },
    signal: controller.signal,
  });

  expect(forgeFetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = forgeFetchMock.mock.calls[0] ?? [];
  expect(url).toBe("https://dummyjson.com/products/42?select=title");
  expect(options?.method).toBe("GET");
  expect(new Headers(options?.headers).get("X-Example")).toBe("forge");
  expect(options?.signal?.aborted).toBe(false);
  controller.abort();
  expect(options?.signal?.aborted).toBe(true);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value).toEqual({ id: 42, title: "Desk" });
});

it("returns the shared HTTP error result from the Forge transport without retrying", async () => {
  forgeFetchMock.mockResolvedValue(
    Response.json({ message: "Slow down" }, { status: 429 }),
  );
  const result = await createDummyJSONClient().GET("/products");
  expect(forgeFetchMock).toHaveBeenCalledTimes(1);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.status).toBe(429);
});
