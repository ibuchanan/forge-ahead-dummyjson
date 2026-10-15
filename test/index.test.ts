import type { ProblemDetails, Result } from "@forge-ahead/errors";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createDummyJSONClient } from "../src/index";

const fetchMock = mock<(request: Request) => Promise<Response>>();
beforeEach(() => fetchMock.mockReset());

describe("createDummyJSONClient", () => {
  it("GETs an endpoint with typed path/query parameters and headers through the supplied transport", async () => {
    const product = { id: 42, title: "Desk" };
    fetchMock.mockResolvedValue(Response.json(product));
    const client = createDummyJSONClient(fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await client.GET("/products/{id}", {
      params: { path: { id: 42 }, query: { select: "title" } },
      headers: { "X-Example": "browser" },
    });

    const typedResult: Result<{ id?: number; title?: string }, ProblemDetails> =
      result;
    expect(typedResult.isOk()).toBe(true);
    if (fetchMock.mock.calls.length === -1) {
      // @ts-expect-error the shared factory requires an explicit transport
      void createDummyJSONClient();
      // @ts-expect-error a path ID is required for product detail
      void client.GET("/products/{id}");
      // @ts-expect-error unknown endpoint
      void client.GET("/not-a-route");
      void client.GET("/products/{id}", {
        // @ts-expect-error endpoint query parameters are path-specific
        params: { path: { id: 42 }, query: { skip: 1 } },
      });
      // @ts-expect-error GET is the only public request method
      void client.POST("/products");
      void client.GET("/products", {
        // @ts-expect-error the host cannot be overridden
        baseUrl: "https://other.example",
      });
      void client.GET("/products", {
        // @ts-expect-error transport is selected at construction only
        fetch: fetchMock,
      });
      void client.GET("/products", {
        // @ts-expect-error the request constructor cannot be overridden
        Request,
      });
      void client.GET("/products", {
        // @ts-expect-error responses are always parsed as JSON
        parseAs: "text",
      });
      void client.GET("/products", {
        // @ts-expect-error the HTTP method cannot be overridden
        method: "POST",
      });
      // @ts-expect-error a detail response is not a product list
      const wrongResult: Result<{ products: unknown[] }, ProblemDetails> =
        result;
      void wrongResult;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(request?.url).toBe("https://dummyjson.com/products/42?select=title");
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("X-Example")).toBe("browser");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(product);
      const id: number | undefined = result.value.id;
      expect(id).toBe(42);
    }
  });

  it("keeps transports isolated between clients", async () => {
    const otherFetch = mock(async (_request: Request) =>
      Response.json({ id: 2 }),
    );
    fetchMock.mockImplementation(async () => Response.json({ id: 1 }));
    const first = createDummyJSONClient(fetchMock);
    const second = createDummyJSONClient(otherFetch);
    const results = await Promise.all([
      first.GET("/products/{id}", { params: { path: { id: 1 } } }),
      second.GET("/products/{id}", { params: { path: { id: 2 } } }),
    ]);
    expect(results.map((result) => result.isOk() && result.value.id)).toEqual([
      1, 2,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(otherFetch).toHaveBeenCalledTimes(1);
  });

  it("strips prohibited overrides even when TypeScript is bypassed", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ products: [], total: 0, skip: 0, limit: 0 }),
    );
    const forbiddenFetch = mock(async () => {
      throw new Error("unexpected transport");
    });
    const forbiddenRequest = mock(() => {
      throw new Error("unexpected Request");
    });
    const result = await createDummyJSONClient(fetchMock).GET("/products", {
      headers: { "X-Example": "runtime-overrides" },
      ...{
        baseUrl: "https://other.example",
        fetch: forbiddenFetch,
        Request: forbiddenRequest,
        parseAs: "text",
        method: "POST",
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk())
      expect(result.value).toEqual({
        products: [],
        total: 0,
        skip: 0,
        limit: 0,
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0].url).toBe(
      "https://dummyjson.com/products",
    );
    expect(fetchMock.mock.calls[0]?.[0].method).toBe("GET");
    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(forbiddenRequest).not.toHaveBeenCalled();
  });

  it("rejects a different resolved origin before invoking the transport", async () => {
    const result = await createDummyJSONClient(fetchMock).GET(
      "/products/{id}",
      {
        params: { path: { id: 42 } },
        pathSerializer: () => "https://other.example/products/42",
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.detail).toContain(
        "must target https://dummyjson.com",
      );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an error with the original HTTP status without retrying", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: "Slow down" }, { status: 429 }),
    );
    const result = await createDummyJSONClient(fetchMock).GET("/products", {
      params: { query: { skip: 10, limit: 5 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new URL(fetchMock.mock.calls[0]?.[0].url ?? "").searchParams.toString(),
    ).toBe("skip=10&limit=5");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.status).toBe(429);
  });

  it("returns a Result error for a network failure without retrying", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });
    const result = await createDummyJSONClient(fetchMock).GET("/products");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.detail).toContain("connection refused");
  });

  it.each([200, 204])(
    "does not turn an empty %i response into success",
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      const result = await createDummyJSONClient(fetchMock).GET("/products");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.status).toBe(status);
    },
  );

  it.each([200, 429])(
    "preserves response status %i for malformed JSON without retrying",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("{broken", {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await createDummyJSONClient(fetchMock).GET("/products");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.status).toBe(status);
        expect(result.error.detail).toMatch(
          status === 200 ? /JSON|parse|Unexpected/i : /GET \/products failed/,
        );
      }
    },
  );
});
