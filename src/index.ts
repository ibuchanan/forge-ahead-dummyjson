import api from "@forge/api";
import {
  err,
  ok,
  problemResult,
  toProblemDetails,
  type ProblemDetails,
  type Result,
} from "@forge-ahead/errors";
import createClient, {
  type FetchResponse,
  type MaybeOptionalInit,
} from "openapi-fetch";
import type { paths } from "./generated";

type PageOffset = { skip: number; limit: number };
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
