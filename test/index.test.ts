import { describe, expect, it, vi } from "vitest";
import { createDummyJSONClient } from "../src/index";

describe("createDummyJSONClient", () => {
  it("sends requests to DummyJSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ products: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await createDummyJSONClient().GET("/products" as never);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toHaveProperty(
        "url",
        "https://dummyjson.com/products",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
