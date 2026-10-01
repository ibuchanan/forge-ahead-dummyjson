import api from "@forge/api";
import type { ProblemDetails, Result } from "@forge-ahead/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDummyJSONClient } from "../src/index";

vi.mock("@forge/api", () => ({ default: { fetch: vi.fn() } }));
const fetchMock = vi.mocked(api.fetch);

beforeEach(() => fetchMock.mockReset());

describe("createDummyJSONClient", () => {
  it("GETs an endpoint with typed path and query parameters using Forge fetch and returns its data", async () => {
    const product = { id: 42, title: "Desk" };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(product), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await createDummyJSONClient().GET("/products/{id}", {
      params: { path: { id: 42 }, query: { select: "title" } },
    });

    const typedResult: Result<{ id?: number; title?: string }, ProblemDetails> =
      result;
    expect(typedResult.isOk()).toBe(true);
    if (fetchMock.mock.calls.length === -1) {
      // @ts-expect-error a path ID is required for product detail
      void createDummyJSONClient().GET("/products/{id}");
      // @ts-expect-error unknown endpoint
      void createDummyJSONClient().GET("/not-a-route");
      void createDummyJSONClient().GET("/products/{id}", {
        // @ts-expect-error endpoint query parameters are path-specific
        params: { path: { id: 42 }, query: { skip: 1 } },
      });
      // @ts-expect-error GET is the only public request method
      void createDummyJSONClient().POST("/products");
      void createDummyJSONClient().GET("/products", {
        // @ts-expect-error host and transport cannot be overridden
        baseUrl: "https://other.example",
      });
      // @ts-expect-error a detail response is not a product list
      const wrongResult: Result<{ products: unknown[] }, ProblemDetails> =
        result;
      void wrongResult;
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]?.[0]))).toHaveProperty(
      "href",
      "https://dummyjson.com/products/42?select=title",
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(product);
      const id: number | undefined = result.value.id;
      expect(id).toBe(42);
    }
  });

  it("returns an error with the original HTTP status without retrying", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Slow down" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await createDummyJSONClient().GET("/products", {
      params: { query: { skip: 10, limit: 5 } },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.toString(),
    ).toBe("skip=10&limit=5");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(429);
    }
  });

  it("returns a Result error for a network failure without retrying", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });

    const result = await createDummyJSONClient().GET("/products");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.detail).toContain("connection refused");
  });

  it("does not turn an empty 200 response into success", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    const result = await createDummyJSONClient().GET("/products");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.status).toBe(200);
  });

  it("returns a Result error with response status for malformed JSON without retrying", async () => {
    fetchMock.mockResolvedValue(
      new Response("{broken", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await createDummyJSONClient().GET("/products");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(200);
      expect(result.error.detail).toMatch(/JSON|parse|Unexpected/i);
    }
  });
});
