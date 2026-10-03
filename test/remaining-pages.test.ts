import { expect, it, mock } from "bun:test";
import { createRemainingPages } from "../src/index";

const buildEvent = ({ skip, limit }: { skip: number; limit: number }) => ({
  body: { skip, limit },
});

const queue = () => ({
  push: mock(async (_events: { body: Record<string, unknown> }[]) => ({
    jobId: "job-1",
  })),
});

it("plans and enqueues only the pages after the processed first page", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 10 });

  expect(q.push).toHaveBeenCalledTimes(1);
  expect(q.push).toHaveBeenCalledWith([
    buildEvent({ skip: 5, limit: 5 }),
    buildEvent({ skip: 10, limit: 5 }),
  ]);
  expect(enqueued.isOk()).toBe(true);
  if (enqueued.isOk()) {
    expect(enqueued.value).toEqual({
      completedBatches: [
        {
          offsets: [
            { skip: 5, limit: 5 },
            { skip: 10, limit: 5 },
          ],
          jobId: "job-1",
        },
      ],
      nextOffset: undefined,
    });
  }
});

it("resumes from a persisted cursor value, not object identity", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const first = await result.value.enqueue(q, buildEvent, { maxEvents: 1 });
  expect(first.isOk()).toBe(true);
  if (!first.isOk()) return;
  expect(first.value.nextOffset).toEqual({ skip: 10, limit: 5 });

  const cursor = JSON.parse(JSON.stringify(first.value.nextOffset)) as {
    skip: number;
    limit: number;
  };

  const resumed = await result.value.resume(cursor, q, buildEvent, {
    maxEvents: 1,
  });

  expect(q.push).toHaveBeenCalledTimes(2);
  expect(q.push).toHaveBeenLastCalledWith([buildEvent({ skip: 10, limit: 5 })]);
  expect(resumed.isOk()).toBe(true);
  if (resumed.isOk()) expect(resumed.value.nextOffset).toBeUndefined();
});

it("rejects a cursor that is not a planned remaining-page offset", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const resumed = await result.value.resume(
    { skip: 7, limit: 5 },
    q,
    buildEvent,
    { maxEvents: 1 },
  );

  expect(q.push).not.toHaveBeenCalled();
  expect(resumed.isErr()).toBe(true);
  if (resumed.isErr())
    expect(resumed.error.detail).toMatch(/cursor|offset|plan/i);
});

it("rejects a cursor whose limit does not match the plan", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const resumed = await result.value.resume(
    { skip: 10, limit: 3 },
    q,
    buildEvent,
    { maxEvents: 1 },
  );

  expect(q.push).not.toHaveBeenCalled();
  expect(resumed.isErr()).toBe(true);
});

it("rejects a cursor with invalid offset values", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  for (const cursor of [
    { skip: -1, limit: 5 },
    { skip: 0.5, limit: 5 },
    { skip: NaN, limit: 5 },
    { skip: 5, limit: -1 },
  ]) {
    const resumed = await result.value.resume(cursor, q, buildEvent, {
      maxEvents: 1,
    });
    expect(resumed.isErr(), JSON.stringify(cursor)).toBe(true);
  }
  expect(q.push).not.toHaveBeenCalled();
});

it("rejects invalid page metadata instead of planning a non-advancing range", () => {
  const result = createRemainingPages({ total: 5, skip: 0, limit: 0 });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.detail).toMatch(/limit|advance/i);
});

it("rejects non-finite, fractional, and unsafe metadata", () => {
  for (const value of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ["total", "skip", "limit"] as const) {
      const result = createRemainingPages({
        total: 10,
        skip: 0,
        limit: 5,
        [key]: value,
      });
      expect(result.isErr(), `${key}=${value}`).toBe(true);
    }
  }
});

it("splits 51 offsets into at most 50 events per push", async () => {
  const result = createRemainingPages({ total: 256, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 51 });

  expect(q.push.mock.calls.map(([events]) => events.length)).toEqual([50, 1]);
  expect(enqueued.isOk()).toBe(true);
  if (enqueued.isOk()) expect(enqueued.value.nextOffset).toBeUndefined();
});

it("stops at the maxEvents budget and resumes from the returned offset", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const first = await result.value.enqueue(q, buildEvent, { maxEvents: 1 });
  expect(first.isOk()).toBe(true);
  if (!first.isOk()) return;
  expect(first.value.nextOffset).toEqual({ skip: 10, limit: 5 });

  const resumed = await result.value.resume(
    first.value.nextOffset as { skip: number; limit: number },
    q,
    buildEvent,
    { maxEvents: 1 },
  );
  expect(resumed.isOk()).toBe(true);
  if (resumed.isOk()) expect(resumed.value.nextOffset).toBeUndefined();
});

it("rejects invalid budgets without pushing", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  for (const maxEvents of [
    0,
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents });
    expect(enqueued.isErr(), `maxEvents=${maxEvents}`).toBe(true);
  }
  expect(q.push).not.toHaveBeenCalled();
});

it("stops on a thrown push and reports confirmed versus uncertain offsets without retry", async () => {
  const result = createRemainingPages({ total: 261, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = {
    push: mock(async (_events: { body: Record<string, unknown> }[]) => {
      if (q.push.mock.calls.length === 2) throw new Error("network lost");
      return { jobId: "accepted-1" };
    }),
  };

  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 52 });

  expect(q.push).toHaveBeenCalledTimes(2);
  expect(enqueued.isErr()).toBe(true);
  if (enqueued.isErr()) {
    expect(enqueued.error.detail).toContain("network lost");
    expect(enqueued.error.completedBatches).toEqual([
      {
        offsets: Array.from({ length: 50 }, (_, i) => ({
          skip: (i + 1) * 5,
          limit: 5,
        })),
        jobId: "accepted-1",
      },
    ]);
    expect(enqueued.error.failedBatch).toEqual({
      offsets: [
        { skip: 255, limit: 5 },
        { skip: 260, limit: 5 },
      ],
    });
    expect(enqueued.error.uncertainOffsets).toEqual([
      { skip: 255, limit: 5 },
      { skip: 260, limit: 5 },
    ]);
    expect(enqueued.error.nextOffset).toBeUndefined();
  }
});

it("does not mark an event-builder failure as an attempted push", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const enqueued = await result.value.enqueue(
    q,
    () => {
      throw new Error("invalid event");
    },
    { maxEvents: 2 },
  );

  expect(q.push).not.toHaveBeenCalled();
  expect(enqueued.isErr()).toBe(true);
  if (enqueued.isErr()) {
    expect(enqueued.error.detail).toContain("invalid event");
    expect(enqueued.error.completedBatches).toEqual([]);
    expect(enqueued.error.failedBatch).toBeUndefined();
    expect(enqueued.error.uncertainOffsets).toBeUndefined();
    expect(enqueued.error.nextUnattemptedOffset).toEqual({ skip: 5, limit: 5 });
  }
});

it("uses the reported effective limit from a nonzero first skip", async () => {
  const result = createRemainingPages({ total: 16, skip: 4, limit: 3 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 10 });

  expect(q.push).toHaveBeenCalledWith([
    buildEvent({ skip: 7, limit: 3 }),
    buildEvent({ skip: 10, limit: 3 }),
    buildEvent({ skip: 13, limit: 3 }),
  ]);
  expect(enqueued.isOk()).toBe(true);
  if (enqueued.isOk()) expect(enqueued.value.nextOffset).toBeUndefined();
});

it("plans nothing for empty or already completed ranges", async () => {
  for (const page of [
    { total: 0, skip: 0, limit: 0 },
    { total: 5, skip: 0, limit: 5 },
    { total: 5, skip: 5, limit: 0 },
    { total: 5, skip: 10, limit: 3 },
  ]) {
    const result = createRemainingPages(page);
    expect(result.isOk(), JSON.stringify(page)).toBe(true);
    if (!result.isOk()) continue;

    const q = queue();
    const enqueued = await result.value.enqueue(q, buildEvent, {
      maxEvents: 10,
    });
    expect(q.push).not.toHaveBeenCalled();
    expect(enqueued.isOk()).toBe(true);
    if (enqueued.isOk()) expect(enqueued.value.nextOffset).toBeUndefined();
  }
});

it("rejects offsets that overflow safe integer arithmetic", () => {
  const result = createRemainingPages({
    total: Number.MAX_SAFE_INTEGER,
    skip: Number.MAX_SAFE_INTEGER - 5,
    limit: 4,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error.detail).toMatch(/offset|overflow|safe/i);
});

it("rejects negative reported metadata", () => {
  const result = createRemainingPages({ total: -1, skip: 0, limit: 5 });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.detail).toMatch(/total|invalid/i);
});

it("honors the budget across the 50-event push boundary", async () => {
  const result = createRemainingPages({ total: 511, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = queue();
  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 51 });

  expect(q.push.mock.calls.map(([events]) => events.length)).toEqual([50, 1]);
  expect(enqueued.isOk()).toBe(true);
  if (enqueued.isOk())
    expect(enqueued.value.nextOffset).toEqual({ skip: 260, limit: 5 });
});

it("reports first-batch push failure without retries or confirmed acceptance", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = {
    push: mock(
      async (
        _events: { body: Record<string, unknown> }[],
      ): Promise<{ jobId: string }> => {
        throw new Error("rate limited");
      },
    ),
  };

  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 2 });

  expect(q.push).toHaveBeenCalledTimes(1);
  expect(enqueued.isErr()).toBe(true);
  if (enqueued.isErr()) {
    expect(enqueued.error.detail).toContain("rate limited");
    expect(enqueued.error.completedBatches).toEqual([]);
    expect(enqueued.error.failedBatch).toEqual({
      offsets: [
        { skip: 5, limit: 5 },
        { skip: 10, limit: 5 },
      ],
    });
    expect(enqueued.error.uncertainOffsets).toEqual([
      { skip: 5, limit: 5 },
      { skip: 10, limit: 5 },
    ]);
  }
});

it("identifies untouched work after a failed batch without offering a safe resume cursor", async () => {
  const result = createRemainingPages({ total: 511, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const q = {
    push: mock(async (_events: { body: Record<string, unknown> }[]) => {
      if (q.push.mock.calls.length === 2) throw new Error("failed");
      return { jobId: "job-1" };
    }),
  };

  const enqueued = await result.value.enqueue(q, buildEvent, {
    maxEvents: 102,
  });

  expect(q.push).toHaveBeenCalledTimes(2);
  expect(enqueued.isErr()).toBe(true);
  if (enqueued.isErr()) {
    expect(enqueued.error.nextOffset).toBeUndefined();
    expect(enqueued.error.nextUnattemptedOffset).toEqual({
      skip: 505,
      limit: 5,
    });
    expect(enqueued.error.failedBatch?.offsets).toEqual(
      Array.from({ length: 50 }, (_, i) => ({
        skip: (i + 51) * 5,
        limit: 5,
      })),
    );
  }
});

it("preserves partial-success failedEvents without claiming the other events were queued", async () => {
  const result = createRemainingPages({ total: 12, skip: 0, limit: 5 });
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;

  const failedEvents = [
    { event: buildEvent({ skip: 10, limit: 5 }), reason: "queue rejected" },
  ];
  const failure = Object.assign(new Error("partial success"), { failedEvents });
  const q = {
    push: mock(
      async (
        _events: { body: Record<string, unknown> }[],
      ): Promise<{ jobId: string }> => {
        throw failure;
      },
    ),
  };

  const enqueued = await result.value.enqueue(q, buildEvent, { maxEvents: 10 });

  expect(enqueued.isErr()).toBe(true);
  if (enqueued.isErr()) {
    expect(enqueued.error.failedBatch).toEqual({
      offsets: [
        { skip: 5, limit: 5 },
        { skip: 10, limit: 5 },
      ],
      failedEvents,
    });
    expect(enqueued.error.uncertainOffsets).toEqual([
      { skip: 5, limit: 5 },
      { skip: 10, limit: 5 },
    ]);
    expect(enqueued.error.completedBatches).toEqual([]);
  }
});
