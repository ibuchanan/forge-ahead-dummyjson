import api from "@forge/api";
import {
  err,
  ok,
  type ProblemDetails,
  problemResult,
  type Result,
  toProblemDetails,
} from "@forge-ahead/errors";
import createClient, {
  type FetchResponse,
  type MaybeOptionalInit,
} from "openapi-fetch";
import type { paths } from "./generated";

export type PageOffset = { skip: number; limit: number };

type CompletedBatch = { offsets: PageOffset[]; jobId: string };

type EnqueueError = ProblemDetails & {
  completedBatches?: CompletedBatch[];
  failedBatch?: { offsets: PageOffset[]; failedEvents?: unknown };
  uncertainOffsets?: PageOffset[];
  nextUnattemptedOffset?: PageOffset;
};

type EnqueueOutcome = {
  completedBatches: CompletedBatch[];
  nextOffset: PageOffset | undefined;
};

type Queue = {
  push(events: { body: Record<string, unknown> }[]): Promise<{ jobId: string }>;
};

type BuildEvent = (offset: PageOffset) => { body: Record<string, unknown> };

/**
 * Own the remaining-page continuation: plan offsets after an already processed
 * first page, enqueue them through a host-owned Forge queue, and resume from a
 * persisted cursor value. The host owns persistence, retries, and idempotent
 * processing; this module owns validated, value-based continuation.
 */
export type RemainingPages = {
  enqueue(
    queue: Queue,
    buildEvent: BuildEvent,
    options: { maxEvents: number },
  ): Promise<Result<EnqueueOutcome, EnqueueError>>;
  resume(
    cursor: PageOffset,
    queue: Queue,
    buildEvent: BuildEvent,
    options: { maxEvents: number },
  ): Promise<Result<EnqueueOutcome, EnqueueError>>;
};

function planOffsets(page: {
  total: number;
  skip: number;
  limit: number;
}): Result<PageOffset[], ProblemDetails> {
  for (const key of ["total", "skip", "limit"] as const) {
    if (!Number.isSafeInteger(page[key]) || page[key] < 0) {
      return err(
        toProblemDetails(`Invalid ${key}: must be a nonnegative safe integer`),
      );
    }
  }
  if (page.limit === 0 && page.skip < page.total) {
    return err(
      toProblemDetails("Invalid limit: page cannot advance before total"),
    );
  }
  const pages: PageOffset[] = [];
  let skip = page.skip;
  while (skip < page.total) {
    if (skip > Number.MAX_SAFE_INTEGER - page.limit) {
      return err(
        toProblemDetails(
          "Invalid offset: advancing would overflow a safe integer",
        ),
      );
    }
    skip += page.limit;
    if (skip < page.total) pages.push({ skip, limit: page.limit });
  }
  return ok(pages);
}

function findOffsetIndex(offsets: PageOffset[], cursor: PageOffset): number {
  if (
    !Number.isSafeInteger(cursor.skip) ||
    cursor.skip < 0 ||
    !Number.isSafeInteger(cursor.limit) ||
    cursor.limit < 0
  ) {
    return -1;
  }
  return offsets.findIndex(
    (offset) => offset.skip === cursor.skip && offset.limit === cursor.limit,
  );
}

async function enqueueFrom(
  offsets: PageOffset[],
  queue: Queue,
  buildEvent: BuildEvent,
  options: { maxEvents: number },
): Promise<Result<EnqueueOutcome, EnqueueError>> {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0) {
    return err(
      toProblemDetails("Invalid maxEvents: must be a positive safe integer"),
    );
  }
  const completedBatches: CompletedBatch[] = [];
  const count = Math.min(offsets.length, options.maxEvents);
  for (let start = 0; start < count; start += 50) {
    const batch = offsets.slice(start, Math.min(start + 50, count));
    let events: { body: Record<string, unknown> }[];
    try {
      events = batch.map(buildEvent);
    } catch (error) {
      return err({
        ...toProblemDetails(error),
        completedBatches,
        nextUnattemptedOffset: batch[0],
      });
    }
    try {
      const { jobId } = await queue.push(events);
      completedBatches.push({ offsets: batch, jobId });
    } catch (error) {
      return err({
        ...toProblemDetails(error),
        completedBatches,
        failedBatch: {
          offsets: batch,
          ...(error !== null &&
          typeof error === "object" &&
          "failedEvents" in error
            ? { failedEvents: error.failedEvents }
            : {}),
        },
        uncertainOffsets: batch,
        nextUnattemptedOffset: offsets[start + batch.length],
      });
    }
  }
  return ok({ completedBatches, nextOffset: offsets[count] });
}

/**
 * Plan and enqueue the pages after an already processed first page, and resume
 * from a persisted cursor value. Only a successful result's nextOffset is a
 * resume cursor. On failure, reconcile the uncertain failed batch before using
 * nextUnattemptedOffset; do not replay it blindly. The host owns persistence,
 * retries, and idempotent processing.
 */
export function createRemainingPages(page: {
  total: number;
  skip: number;
  limit: number;
}): Result<RemainingPages, ProblemDetails> {
  const planned = planOffsets(page);
  if (planned.isErr()) return err(planned.error);
  const offsets = planned.value;

  return ok({
    enqueue: (queue, buildEvent, options) =>
      enqueueFrom(offsets, queue, buildEvent, options),
    resume: async (cursor, queue, buildEvent, options) => {
      const index = findOffsetIndex(offsets, cursor);
      if (index === -1) {
        return err(
          toProblemDetails(
            "Invalid cursor: not a planned remaining-page offset",
          ),
        );
      }
      return enqueueFrom(offsets.slice(index), queue, buildEvent, options);
    },
  });
}

type CollectionKey<Page> = {
  [Key in keyof Page]: Page[Key] extends readonly unknown[] ? Key : never;
}[keyof Page];

/** Fetch a raw offset page without changing its items or reported metadata. */
export async function fetchRawPage<
  Page extends { total: number; skip: number; limit: number },
  Error,
  Key extends CollectionKey<Page>,
>(
  fetchPage: (offset: PageOffset) => Promise<Result<Page, Error>>,
  collection: Key,
  offset: PageOffset,
): Promise<
  Result<
    {
      records: Page[Key];
      total: number;
      skip: number;
      limit: number;
    },
    Error
  >
> {
  return (await fetchPage(offset)).map((page) => ({
    records: page[collection],
    total: page.total,
    skip: page.skip,
    limit: page.limit,
  }));
}

type GetOptions<Path extends keyof paths> = Omit<
  NonNullable<MaybeOptionalInit<paths[Path], "get">>,
  "baseUrl" | "fetch" | "Request" | "parseAs" | "method"
>;
type Get = <Path extends keyof paths>(
  path: Path,
  ...init: undefined extends MaybeOptionalInit<paths[Path], "get">
    ? [options?: GetOptions<Path>]
    : [options: GetOptions<Path>]
) => Promise<
  Result<
    Extract<
      FetchResponse<paths[Path]["get"], object, "application/json">,
      { data: unknown }
    >["data"],
    ProblemDetails
  >
>;

/** Create a GET-only DummyJSON client for a Forge backend. */
export function createDummyJSONClient(): { GET: Get } {
  const client = createClient<paths>({ baseUrl: "https://dummyjson.com" });
  return {
    GET: (async (path: keyof paths, options?: Record<string, unknown>) => {
      let status: number | undefined;
      try {
        const requestOptions = { ...options };
        for (const key of [
          "baseUrl",
          "fetch",
          "Request",
          "parseAs",
          "method",
        ]) {
          delete requestOptions[key];
        }
        const result = await (
          client.GET as (
            path: keyof paths,
            options?: unknown,
          ) => Promise<{
            data?: unknown;
            error?: unknown;
            response: Response;
          }>
        )(path, {
          ...requestOptions,
          fetch: async (request: Request) => {
            if (new URL(request.url).origin !== "https://dummyjson.com") {
              throw new Error(
                "DummyJSON requests must target https://dummyjson.com",
              );
            }
            const response = await api.fetch(request.url, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              signal: request.signal,
            });
            status = response.status;
            // Forge's Response has the methods used by openapi-fetch, but its declared type is narrower.
            return response as unknown as Response;
          },
        });
        if (!result.response.ok) {
          return err({
            ...toProblemDetails(
              result.error,
              result.response.status,
              `GET ${path} failed`,
            ),
            status: result.response.status,
          });
        }
        if (result.data === undefined) {
          return err({
            ...toProblemDetails("Empty JSON response"),
            status: result.response.status,
          });
        }
        return ok(result.data);
      } catch (error) {
        return status !== undefined
          ? err({ ...toProblemDetails(error), status })
          : problemResult(error);
      }
    }) as Get,
  };
}
