import {
  createDummyJSONClient,
  enqueueRemainingPages,
  fetchRawPage,
  planRemainingPages,
} from "@forge-ahead/dummyjson";

const client = createDummyJSONClient();
const product = client.GET("/products/{id}", {
  params: { path: { id: 42 }, query: { select: "title" } },
});
const products = client.GET("/products", {
  params: { query: { skip: 0, limit: 10 } },
});

// @ts-expect-error the package exposes GET, not write operations
client.POST("/products/add");
// @ts-expect-error the product detail needs an ID
client.GET("/products/{id}");
// @ts-expect-error unknown routes are not in the reviewed contract
client.GET("/unknown");

async function processFirstPage() {
  const fetchProducts = ({ skip, limit }: { skip: number; limit: number }) =>
    client.GET("/products", { params: { query: { skip, limit } } });
  const first = await fetchRawPage(fetchProducts, "products", {
    skip: 0,
    limit: 10,
  });
  if (first.isErr()) return first.error;

  const title: string | undefined = first.value.records[0]?.title;
  const offsets = planRemainingPages(first.value);
  if (offsets.isErr()) return offsets.error;

  const queue = {
    push: async (_events: { body: Record<string, unknown> }[]) => ({
      jobId: "host-job",
    }),
  };
  const result = await enqueueRemainingPages(
    queue,
    offsets.value,
    ({ skip, limit }) => ({ body: { skip, limit } }),
    { maxEvents: 50 },
  );
  if (result.isOk()) {
    const nextSkip: number | undefined = result.value.nextOffset?.skip;
    return { title, nextSkip };
  }
  return result.error;
}

void product;
void products;
void processFirstPage;
