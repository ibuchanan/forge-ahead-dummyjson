import { expect, it } from "vitest";
import { planRemainingPages } from "../src/lib/index";

it("plans only the pages after the processed first page", () => {
  const result = planRemainingPages({ total: 12, skip: 0, limit: 5 });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual([
      { skip: 5, limit: 5 },
      { skip: 10, limit: 5 },
    ]);
  }
});

it("uses the reported effective limit from a nonzero first skip", () => {
  // The host requested 10, but the already processed page reported an effective limit of 3.
  const result = planRemainingPages({ total: 16, skip: 4, limit: 3 });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual([
      { skip: 7, limit: 3 },
      { skip: 10, limit: 3 },
      { skip: 13, limit: 3 },
    ]);
  }
});

it("plans nothing for empty or already completed ranges, including a zero-limit complete page", () => {
  for (const page of [
    { total: 0, skip: 0, limit: 0 },
    { total: 5, skip: 0, limit: 5 },
    { total: 5, skip: 5, limit: 0 },
    { total: 5, skip: 10, limit: 3 },
  ]) {
    const result = planRemainingPages(page);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  }
});

it("rejects a non-advancing zero limit while records remain", () => {
  const result = planRemainingPages({ total: 5, skip: 0, limit: 0 });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.detail).toMatch(/limit|advance/i);
});

it("rejects offsets that overflow safe integer arithmetic", () => {
  const result = planRemainingPages({
    total: Number.MAX_SAFE_INTEGER,
    skip: Number.MAX_SAFE_INTEGER - 5,
    limit: 4,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error.detail).toMatch(/offset|overflow|safe/i);
});

it("rejects negative reported metadata instead of silently treating it as complete", () => {
  const result = planRemainingPages({ total: -1, skip: 0, limit: 5 });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.detail).toMatch(/total|invalid/i);
});

it("rejects non-finite, fractional, and unsafe metadata", () => {
  for (const value of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["total", "skip", "limit"] as const) {
      const result = planRemainingPages({
        total: 10,
        skip: 0,
        limit: 5,
        [key]: value,
      });
      expect(result.isErr(), `${key}=${value}`).toBe(true);
    }
  }
});
