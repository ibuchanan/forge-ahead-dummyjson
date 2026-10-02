import {
  err,
  ok,
  toProblemDetails,
  type ProblemDetails,
  type Result,
} from "@forge-ahead/errors";
import { expect, it, vi } from "vitest";
import { fetchRawPage } from "../src/lib/index";

it("returns raw products and server-reported page metadata", async () => {
  const product = { id: 42, title: "Desk", extra: { color: "blue" } };
  const response = {
    products: [product],
    total: 95,
    skip: 20,
    limit: 1,
  };
  const fetchPage = vi.fn(async (_options: { skip: number; limit: number }) =>
    ok(response),
  );

  const result = await fetchRawPage(fetchPage, "products", {
    skip: 20,
    limit: 10,
  });

  expect(fetchPage).toHaveBeenCalledExactlyOnceWith({ skip: 20, limit: 10 });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    const records: typeof response.products = result.value.records;
    expect(records).toBe(response.products);
    expect(records[0]).toBe(product);
    expect(result.value).toEqual({
      records: [product],
      total: 95,
      skip: 20,
      limit: 1,
    });
  }
  expect(response.products).toEqual([product]);
});

it("returns an empty collection with the reported metadata", async () => {
  const response = {
    comments: [] as { id: number }[],
    total: 0,
    skip: 0,
    limit: 0,
  };
  const result = await fetchRawPage(
    async (_offset: { skip: number; limit: number }) => ok(response),
    "comments",
    { skip: 0, limit: 30 },
  );

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({ records: [], total: 0, skip: 0, limit: 0 });
    expect(result.value.records).toBe(response.comments);
  }
});

it("forwards a failed fetch as the same Result error without retrying", async () => {
  const problem = { ...toProblemDetails("Rate limited"), status: 429 };
  const fetchPage = vi.fn(
    async (_offset: {
      skip: number;
      limit: number;
    }): Promise<
      Result<
        {
          products: { id: number }[];
          total: number;
          skip: number;
          limit: number;
        },
        ProblemDetails
      >
    > => err(problem),
  );

  const result = await fetchRawPage(fetchPage, "products", {
    skip: 10,
    limit: 5,
  });

  expect(fetchPage).toHaveBeenCalledExactlyOnceWith({ skip: 10, limit: 5 });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error).toBe(problem);
});

it("selects users without mapping their fields or losing the item type", async () => {
  const user = { id: 7, firstName: "Ada", custom: ["original"] };
  const response = { users: [user], total: 1, skip: 0, limit: 1 };
  const fetchPage = vi.fn(async (_offset: { skip: number; limit: number }) =>
    ok(response),
  );

  const result = await fetchRawPage(fetchPage, "users", {
    skip: 0,
    limit: 30,
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    const firstName: string = result.value.records[0].firstName;
    expect(firstName).toBe("Ada");
    expect(result.value.records).toBe(response.users);
    expect(result.value.records[0]).toBe(user);
  }
  if (fetchPage.mock.calls.length === -1) {
    // @ts-expect-error the requested collection must be an array key on the response
    void fetchRawPage(fetchPage, "products", { skip: 0, limit: 30 });
  }
});
