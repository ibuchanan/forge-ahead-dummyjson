export interface ReviewedRoute {
  family: string;
  suffix: string;
  shape: string;
  query: string;
  responseFamily: string;
}

interface QueryParamDef {
  type: string;
  description: string;
  minimum?: number;
  enum?: string[];
  format?: string;
}

interface Parameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: unknown;
  description?: string;
}

const queryDefinitions: Record<string, QueryParamDef> = {
  limit: {
    type: "integer",
    minimum: 0,
    description:
      "Maximum returned records; `0` requests all remaining records. Defaults to 30.",
  },
  skip: {
    type: "integer",
    minimum: 0,
    description: "Number of matching records to skip. Defaults to 0.",
  },
  sortBy: {
    type: "string",
    description: "Record field used to sort the list.",
  },
  order: {
    type: "string",
    enum: ["asc", "desc"],
    description: "Sort direction when `sortBy` is supplied.",
  },
  select: {
    type: "string",
    description:
      "Comma-separated field names. Selected responses may omit other fields; `id` is retained.",
  },
  q: { type: "string", description: "Case-insensitive search text." },
  key: { type: "string", description: "User field path to compare." },
  value: {
    type: "string",
    description: "String representation of the user field value to match.",
  },
  modifiedAfter: {
    type: "string",
    format: "date-time",
    description: "Inclusive lower bound for product `meta.updatedAt`.",
  },
  modifiedBefore: {
    type: "string",
    format: "date-time",
    description: "Inclusive upper bound for product `meta.updatedAt`.",
  },
};

const queryGroups: Record<string, string[]> = {
  page: ["limit", "skip", "sortBy", "order", "select"],
  offset: ["limit", "skip"],
  offsetSelect: ["limit", "skip", "select"],
  select: ["select"],
  search: ["q", "limit", "skip", "sortBy", "order", "select"],
  filter: ["key", "value", "limit", "skip", "sortBy", "order", "select"],
  productPage: [
    "limit",
    "skip",
    "sortBy",
    "order",
    "select",
    "modifiedAfter",
    "modifiedBefore",
  ],
  productSearch: [
    "q",
    "limit",
    "skip",
    "sortBy",
    "order",
    "select",
    "modifiedAfter",
    "modifiedBefore",
  ],
};

const fail = (message: string): never => {
  throw new Error(message);
};

export function buildOperation(path: string, route: ReviewedRoute) {
  const { family, suffix, shape, query, responseFamily } = route;
  const parameters: Parameter[] = [...path.matchAll(/\{([^}]+)\}/g)].map(
    ([, name]) => ({
      name,
      in: "path",
      required: true,
      schema:
        name === "id" ||
        name === "userId" ||
        name === "postId" ||
        name === "length"
          ? { type: "integer", minimum: 1 }
          : { type: "string" },
    }),
  );
  for (const name of queryGroups[query] ?? []) {
    const definition = queryDefinitions[name];
    parameters.push({
      name,
      in: "query",
      required: false,
      schema: Object.fromEntries(
        Object.entries(definition).filter(([key]) => key !== "description"),
      ),
      description: definition.description,
    });
  }
  if (query && !queryGroups[query]) fail(`Unreviewed query group: ${query}`);
  if (path.includes("{length}")) {
    const lengthParam =
      parameters.find((param) => param.name === "length") ??
      fail(`Missing length parameter for ${path}`);
    lengthParam.description =
      "Number of random records; 1\u201310 returns that many records, other values return an empty array.";
  }

  let response: unknown;
  if (shape === "page")
    response = { $ref: `#/components/schemas/${responseFamily}Page` };
  else if (
    shape === "item" ||
    (shape === "random" && !path.includes("{length}"))
  )
    response = { $ref: `#/components/schemas/${family}` };
  else if (shape === "random")
    response = {
      type: "array",
      items: { $ref: `#/components/schemas/${family}` },
    };
  else if (shape === "strings")
    response = { type: "array", items: { type: "string" } };
  else if (shape === "slugs")
    response = {
      type: "array",
      items: { $ref: "#/components/schemas/slug" },
    };
  else fail(`Unreviewed response shape ${shape}`);

  return {
    tags: [family],
    summary: `Get ${family} ${suffix === "/" ? "list" : suffix.replaceAll("/", " ").trim()}`,
    ...(parameters.length ? { parameters } : {}),
    responses: {
      200: {
        description: "Successful JSON response.",
        content: { "application/json": { schema: response } },
      },
    },
  };
}

type ObjectValue = Record<string, unknown>;

const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

function semanticProjection(operation: unknown) {
  const value = object(operation) ?? {};
  const parameters = Array.isArray(value.parameters)
    ? value.parameters
        .map((parameter) => {
          const item = object(parameter) ?? {};
          return {
            name: item.name,
            in: item.in,
            required: item.required,
            schema: item.schema,
          };
        })
        .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
    : [];
  const response = object(object(value.responses)?.["200"]);
  const content = object(response?.content);
  const json = object(content?.["application/json"]);
  return {
    tags: Array.isArray(value.tags) ? [...value.tags].sort() : [],
    parameters,
    mediaTypes: Object.keys(content ?? {}).sort(),
    response: json?.schema,
  };
}

export function contractSemanticDrift(
  reviewedPaths: Map<string, ReviewedRoute>,
  contractPaths: Record<string, unknown>,
): string[] {
  const expectedPaths = [...reviewedPaths.keys()].sort();
  const actualPaths = Object.keys(contractPaths).sort();
  const drift: string[] = [];

  for (const path of expectedPaths)
    if (!(path in contractPaths)) drift.push(`missing: GET ${path}`);
  for (const path of actualPaths)
    if (!reviewedPaths.has(path)) drift.push(`extra: GET ${path}`);

  for (const path of expectedPaths) {
    const route = reviewedPaths.get(path);
    const pathItem = object(contractPaths[path]);
    if (!route || !pathItem) continue;
    const methods = Object.keys(pathItem).sort();
    if (methods.length !== 1 || methods[0] !== "get") {
      drift.push(
        `changed: GET ${path} operations expected ["get"], found ${JSON.stringify(methods)}`,
      );
      continue;
    }
    const expected = semanticProjection(buildOperation(path, route));
    const actual = semanticProjection(pathItem.get);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      drift.push(
        `changed: GET ${path}\n  expected ${JSON.stringify(expected)}\n  found    ${JSON.stringify(actual)}`,
      );
    }
  }
  return drift;
}
