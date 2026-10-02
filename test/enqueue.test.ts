import { expect, it, vi } from "vitest";
import { enqueueRemainingPages } from "../src/index";

const pages = [
  { skip: 5, limit: 5 },
  { skip: 10, limit: 5 },
];
const buildEvent = ({ skip, limit }: { skip: number; limit: number }) => ({
  body: { skip, limit },
});

it("does not push when there are no remaining pages", async () => {
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job-1",
    })),
  };

  const result = await enqueueRemainingPages(queue, [], buildEvent, {
    maxEvents: 1,
  });

  expect(queue.push).not.toHaveBeenCalled();
  expect(result.isOk()).toBe(true);
  if (result.isOk())
    expect(result.value).toEqual({
      completedBatches: [],
      nextOffset: undefined,
    });
});

it("pushes exactly 50 events in one batch", async () => {
  const offsets = Array.from({ length: 50 }, (_, i) => ({
    skip: (i + 1) * 5,
    limit: 5,
  }));
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };

  const result = await enqueueRemainingPages(queue, offsets, buildEvent, {
    maxEvents: 50,
  });

  expect(queue.push).toHaveBeenCalledExactlyOnceWith(offsets.map(buildEvent));
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.nextOffset).toBeUndefined();
});

it("splits 51 offsets into at most 50 events per push", async () => {
  const offsets = Array.from({ length: 51 }, (_, i) => ({
    skip: (i + 1) * 5,
    limit: 5,
  }));
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };

  const result = await enqueueRemainingPages(queue, offsets, buildEvent, {
    maxEvents: 51,
  });

  expect(queue.push.mock.calls.map(([events]) => events.length)).toEqual([
    50, 1,
  ]);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.completedBatches).toEqual([
      { offsets: offsets.slice(0, 50), jobId: "job" },
      { offsets: offsets.slice(50), jobId: "job" },
    ]);
    expect(result.value.nextOffset).toBeUndefined();
  }
});

it("stops at the maxEvents budget and resumes from the returned offset", async () => {
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };
  const first = await enqueueRemainingPages(queue, pages, buildEvent, {
    maxEvents: 1,
  });

  expect(queue.push).toHaveBeenCalledExactlyOnceWith([buildEvent(pages[0])]);
  expect(first.isOk()).toBe(true);
  if (first.isOk()) {
    expect(first.value).toEqual({
      completedBatches: [{ offsets: [pages[0]], jobId: "job" }],
      nextOffset: pages[1],
    });
    const nextOffset = first.value.nextOffset;
    if (nextOffset === undefined) throw new Error("expected a resume offset");
    const resumed = await enqueueRemainingPages(
      queue,
      pages.slice(pages.indexOf(nextOffset)),
      buildEvent,
      { maxEvents: 1 },
    );
    expect(resumed.isOk()).toBe(true);
    if (resumed.isOk()) expect(resumed.value.nextOffset).toBeUndefined();
    expect(queue.push).toHaveBeenLastCalledWith([buildEvent(pages[1])]);
  }
});

it("honors the budget across the 50-event push boundary", async () => {
  const offsets = Array.from({ length: 102 }, (_, i) => ({
    skip: (i + 1) * 5,
    limit: 5,
  }));
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };

  const result = await enqueueRemainingPages(queue, offsets, buildEvent, {
    maxEvents: 51,
  });

  expect(queue.push.mock.calls.map(([events]) => events.length)).toEqual([
    50, 1,
  ]);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.nextOffset).toEqual(offsets[51]);
});

it("rejects invalid budgets without pushing", async () => {
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };
  for (const maxEvents of [
    0,
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = await enqueueRemainingPages(queue, pages, buildEvent, {
      maxEvents,
    });
    expect(result.isErr(), `maxEvents=${maxEvents}`).toBe(true);
  }
  expect(queue.push).not.toHaveBeenCalled();
});

it("stops on a thrown push and reports confirmed versus uncertain offsets without retry", async () => {
  const offsets = Array.from({ length: 52 }, (_, i) => ({
    skip: (i + 1) * 5,
    limit: 5,
  }));
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => {
      if (queue.push.mock.calls.length === 2) throw new Error("network lost");
      return { jobId: "accepted-1" };
    }),
  };

  const result = await enqueueRemainingPages(queue, offsets, buildEvent, {
    maxEvents: 52,
  });

  expect(queue.push).toHaveBeenCalledTimes(2);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.detail).toContain("network lost");
    expect(result.error.completedBatches).toEqual([
      { offsets: offsets.slice(0, 50), jobId: "accepted-1" },
    ]);
    expect(result.error.failedBatch).toEqual({ offsets: offsets.slice(50) });
    expect(result.error.uncertainOffsets).toEqual(offsets.slice(50));
    expect(result.error.nextOffset).toBeUndefined();
  }
});

it("does not mark an event-builder failure as an attempted push", async () => {
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job",
    })),
  };
  const result = await enqueueRemainingPages(
    queue,
    pages,
    () => {
      throw new Error("invalid event");
    },
    { maxEvents: 2 },
  );

  expect(queue.push).not.toHaveBeenCalled();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.detail).toContain("invalid event");
    expect(result.error.completedBatches).toEqual([]);
    expect(result.error.failedBatch).toBeUndefined();
    expect(result.error.uncertainOffsets).toBeUndefined();
    expect(result.error.nextUnattemptedOffset).toEqual(pages[0]);
  }
});

it("reports first-batch push failure without retries or confirmed acceptance", async () => {
  const queue = {
    push: vi.fn(
      async (
        _events: { body: Record<string, unknown> }[],
      ): Promise<{ jobId: string }> => {
        throw new Error("rate limited");
      },
    ),
  };

  const result = await enqueueRemainingPages(queue, pages, buildEvent, {
    maxEvents: 2,
  });

  expect(queue.push).toHaveBeenCalledExactlyOnceWith(pages.map(buildEvent));
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.detail).toContain("rate limited");
    expect(result.error.completedBatches).toEqual([]);
    expect(result.error.failedBatch).toEqual({ offsets: pages });
    expect(result.error.uncertainOffsets).toEqual(pages);
  }
});

it("identifies untouched work after a failed batch without offering a safe resume cursor", async () => {
  const offsets = Array.from({ length: 102 }, (_, i) => ({
    skip: (i + 1) * 5,
    limit: 5,
  }));
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => {
      if (queue.push.mock.calls.length === 2) throw new Error("failed");
      return { jobId: "job-1" };
    }),
  };

  const result = await enqueueRemainingPages(queue, offsets, buildEvent, {
    maxEvents: 102,
  });

  expect(queue.push).toHaveBeenCalledTimes(2);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.nextOffset).toBeUndefined();
    expect(result.error.nextUnattemptedOffset).toEqual(offsets[100]);
    expect(result.error.failedBatch?.offsets).toEqual(offsets.slice(50, 100));
  }
});

it("preserves partial-success failedEvents without claiming the other events were queued", async () => {
  const failedEvents = [
    { event: buildEvent(pages[1]), reason: "queue rejected" },
  ];
  const failure = Object.assign(new Error("partial success"), { failedEvents });
  const queue = {
    push: vi.fn(
      async (
        _events: { body: Record<string, unknown> }[],
      ): Promise<{ jobId: string }> => {
        throw failure;
      },
    ),
  };

  const result = await enqueueRemainingPages(queue, pages, buildEvent, {
    maxEvents: 10,
  });

  expect(queue.push).toHaveBeenCalledOnce();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.failedBatch).toEqual({ offsets: pages, failedEvents });
    expect(result.error.uncertainOffsets).toEqual(pages);
    expect(result.error.completedBatches).toEqual([]);
  }
});

it("pushes planned remaining pages through a host-supplied queue", async () => {
  const queue = {
    push: vi.fn(async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "job-1",
    })),
  };

  const result = await enqueueRemainingPages(queue, pages, buildEvent, {
    maxEvents: 10,
  });

  expect(queue.push).toHaveBeenCalledExactlyOnceWith(pages.map(buildEvent));
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      completedBatches: [{ offsets: pages, jobId: "job-1" }],
      nextOffset: undefined,
    });
  }
});
