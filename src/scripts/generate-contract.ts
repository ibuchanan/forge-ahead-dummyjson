import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type RouteInventory = Record<
  string,
  {
    mounts: string[];
    routes: [string, string, string, string?][];
  }
>;
interface ReviewedRoute {
  family: string;
  suffix: string;
  shape: string;
  query: string;
  responseFamily: string;
}

const inventory: RouteInventory = JSON.parse(
  readFileSync("specs/reviewed-routes.json", "utf8"),
);
const contractFile = "specs/dummyjson.openapi.json";
const sources = "vendor/DummyJSON/src/routes";
const fail = (message: string): never => {
  throw new Error(message);
};
const parse = (file: string) => {
  const ast = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics = (ast as { parseDiagnostics?: { messageText: string }[] })
    .parseDiagnostics;
  if (diagnostics?.length)
    fail(`Cannot parse ${file}: ${diagnostics[0].messageText}`);
  return ast;
};
const literal = (node: ts.Node, file: string): string =>
  ts.isStringLiteral(node)
    ? node.text
    : fail(`Unsupported dynamic path in ${file}: ${node.getText()}`);
const callKind = (node: ts.Node): string | undefined =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.expression.getText() === "router"
    ? node.expression.name.text
    : undefined;
function calls(
  file: string,
  visitor: (node: ts.CallExpression, kind: string, file: string) => void,
) {
  const ast = parse(file);
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isElementAccessExpression(node.expression) &&
      node.expression.expression.getText() === "router"
    )
      fail(`Unsupported computed router call in ${file}: ${node.getText()}`);
    const kind = ts.isCallExpression(node) ? callKind(node) : undefined;
    if (ts.isCallExpression(node) && kind) visitor(node, kind, file);
    ts.forEachChild(node, walk);
  };
  walk(ast);
}
function expand(prefix: string, suffix: string): string[] {
  if (!/^\/(?:[A-Za-z0-9/-]|:[A-Za-z][A-Za-z0-9_]*\??)*$/.test(suffix))
    fail(`Unsupported route syntax: ${suffix}`);
  if (
    (suffix.match(/\?/g) || []).length > 1 ||
    (suffix.includes("?") && !/:length\?$/.test(suffix))
  )
    fail(`Unsupported optional route: ${suffix}`);
  const full = prefix + (suffix === "/" ? "" : suffix);
  const variants = full.endsWith("?")
    ? [full.replace(/\/:length\?$/, ""), full.slice(0, -1)]
    : [full];
  return variants.map((path) =>
    path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}"),
  );
}
function discover(): Set<string> {
  const mounts = new Map<string, string[]>();
  calls(`${sources}/index.js`, (node, kind, file) => {
    if (kind !== "use") return;
    const target = node.arguments[1]?.getText();
    for (const family of Object.keys(inventory)) {
      if (target !== `${family}Routes`) continue;
      if (mounts.has(family)) fail(`Duplicate mount: ${family}`);
      const paths = node.arguments[0];
      if (!paths || !ts.isArrayLiteralExpression(paths))
        fail(`Unsupported mount for ${family} in ${file}`);
      mounts.set(
        family,
        (paths as ts.ArrayLiteralExpression).elements.map((element) =>
          literal(element, file),
        ),
      );
    }
  });
  const paths = new Set<string>();
  for (const family of Object.keys(inventory)) {
    const file = `${sources}/${family}.js`;
    const prefixes = mounts.get(family) ?? fail(`Missing mount: ${family}`);
    calls(file, (node, kind) => {
      if (!["get", "post", "put", "patch", "delete", "use"].includes(kind))
        fail(`Unhandled router.${kind} in ${file}`);
      if (kind !== "get") return;
      const suffix = literal(node.arguments[0], file);
      if (suffix === "/me" && family === "user") {
        if (node.arguments[1]?.getText() !== "authUser")
          fail(`Expected authUser middleware on ${file} /me`);
        return;
      }
      if (node.arguments.length !== 2)
        fail(`Unreviewed middleware/handler on ${file} ${suffix}`);
      for (const prefix of prefixes)
        for (const path of expand(prefix, suffix)) {
          if (paths.has(path)) fail(`Duplicate GET ${path}`);
          paths.add(path);
        }
    });
    if (JSON.stringify(prefixes) !== JSON.stringify(inventory[family].mounts))
      fail(`Mount drift for ${family}: ${prefixes}`);
  }
  return paths;
}
function reviewed(): Map<string, ReviewedRoute> {
  const paths = new Map<string, ReviewedRoute>();
  for (const [family, { mounts, routes }] of Object.entries(inventory)) {
    for (const [suffix, shape, query, responseFamily] of routes)
      for (const mount of mounts) {
        for (const path of expand(mount, suffix)) {
          if (paths.has(path)) fail(`Duplicate reviewed path ${path}`);
          paths.set(path, {
            family,
            suffix,
            shape,
            query,
            responseFamily: responseFamily ?? family,
          });
        }
      }
  }
  return paths;
}
function compare(actual: Set<string>, expected: Set<string>, label: string) {
  const missing = [...expected].filter((path) => !actual.has(path)).sort();
  const extra = [...actual].filter((path) => !expected.has(path)).sort();
  if (missing.length || extra.length)
    fail(
      `${label}: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
    );
  console.log(
    `${label}: ${actual.size}/${expected.size}, missing [], extra []`,
  );
}
const sourcePaths = discover();
const reviewedPaths = reviewed();
compare(sourcePaths, new Set(reviewedPaths.keys()), "GET route coverage");
if (sourcePaths.size !== 84)
  fail(`Expected 84 concrete paths; found ${sourcePaths.size}`);

if (process.argv.includes("--check")) {
  const existing = JSON.parse(readFileSync(contractFile, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  compare(
    new Set(Object.keys(existing.paths)),
    sourcePaths,
    "Committed contract coverage",
  );
  if (
    Object.values(existing.paths).some(
      (path) => Object.keys(path).join() !== "get",
    )
  )
    fail("Non-GET operation in contract");
  process.exit(0);
}
if (!process.argv.includes("--draft"))
  fail("Usage: npm run contract:check | npm run generate:contract");

const families: Record<string, string> = {
  product: "products",
  user: "users",
  cart: "carts",
  post: "posts",
  comment: "comments",
  todo: "todos",
  recipe: "recipes",
  quote: "quotes",
};
const schemas: JsonObject = {};
const temp = mkdtempSync("tmp_rovo_contract_");
try {
  for (const [family, plural] of Object.entries(families)) {
    const file = join(temp, `${family}.json`);
    execFileSync(
      "npm",
      [
        "exec",
        "--no",
        "--",
        "quicktype",
        "--lang",
        "schema",
        "--src",
        `vendor/DummyJSON/database/${plural}.json`,
        "--top-level",
        `${plural}Dataset`,
        "--out",
        file,
        "--no-date-times",
      ],
      { stdio: "pipe" },
    );
    const draft = JSON.parse(readFileSync(file, "utf8"));
    const root = draft.items.$ref.replace("#/definitions/", "");
    function review(value: JsonValue): JsonValue {
      if (Array.isArray(value)) return value.map(review);
      if (!value || typeof value !== "object") return value;
      const result: JsonObject = {};
      for (const [key, child] of Object.entries(value)) {
        if (
          [
            "required",
            "qt-uri-protocols",
            "qt-uri-extensions",
            "additionalProperties",
            "$schema",
          ].includes(key)
        )
          continue;
        if (key === "format" && child === "integer") continue;
        if (key === "enum") continue; // Sampled enum values cannot prove a closed vocabulary.
        result[key] =
          key === "$ref"
            ? (child as string).replace(
                "#/definitions/",
                `#/components/schemas/${family}_`,
              )
            : review(child);
      }
      return result;
    }
    for (const [name, schema] of Object.entries(
      draft.definitions as Record<string, JsonValue>,
    )) {
      schemas[`${family}_${name}`] = review(schema);
    }
    schemas[family] = { $ref: `#/components/schemas/${family}_${root}` };
    if (family === "user")
      for (const field of ["password", "ssn"]) {
        const properties = (schemas[`user_${root}`] as JsonObject).properties;
        const prop = (properties as JsonObject | undefined)?.[field];
        if (prop && typeof prop === "object" && !Array.isArray(prop))
          prop.description =
            "Sensitive field returned by the pinned dataset; do not log or persist unnecessarily.";
      }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
for (const [family, plural] of Object.entries(families)) {
  schemas[`${family}Page`] = {
    type: "object",
    required: [plural, "total", "skip", "limit"],
    properties: {
      [plural]: {
        type: "array",
        items: { $ref: `#/components/schemas/${family}` },
      },
      total: { type: "integer" },
      skip: { type: "integer" },
      limit: {
        type: "integer",
        description:
          "Effective returned item count, not necessarily the requested limit.",
      },
    },
  };
}
schemas.slug = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
  },
};
interface QueryParamDef {
  type: string;
  description: string;
  minimum?: number;
  enum?: string[];
  format?: string;
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
interface Parameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: unknown;
  description?: string;
}
const paths: Record<string, unknown> = {};
for (const [path, { family, suffix, shape, query, responseFamily }] of [
  ...reviewedPaths,
].sort(([a], [b]) => a.localeCompare(b))) {
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
  for (const name of queryGroups[query] ?? [])
    parameters.push({
      name,
      in: "query",
      required: false,
      schema: Object.fromEntries(
        Object.entries(queryDefinitions[name]).filter(
          ([key]) => key !== "description",
        ),
      ),
      description: queryDefinitions[name].description,
    });
  if (query && !queryGroups[query]) fail(`Unreviewed query group: ${query}`);
  if (path.includes("{length}")) {
    const lengthParam =
      parameters.find((param) => param.name === "length") ??
      fail(`Missing length parameter for ${path}`);
    lengthParam.description =
      "Number of random records; 1–10 returns that many records, other values return an empty array.";
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
    response = { type: "array", items: { $ref: "#/components/schemas/slug" } };
  else fail(`Unreviewed response shape ${shape}`);
  paths[path] = {
    get: {
      tags: [family],
      summary: `Get ${family} ${suffix === "/" ? "list" : suffix.replaceAll("/", " ").trim()}`,
      ...(parameters.length ? { parameters } : {}),
      responses: {
        200: {
          description: "Successful JSON response.",
          content: { "application/json": { schema: response } },
        },
      },
    },
  };
}
const contract = {
  openapi: "3.1.0",
  info: {
    title: "DummyJSON public read-only API",
    version: "1.0.0",
    description:
      "Reviewed against the pinned DummyJSON source. Record fields are dataset-inferred and optional because `select` and future dataset revisions can change their presence; no dataset values are embedded. HTTP errors are handled by the client layer.",
  },
  servers: [{ url: "https://dummyjson.com" }],
  paths,
  components: { schemas },
};
writeFileSync(contractFile, `${JSON.stringify(contract, null, 2)}\n`);
console.log(
  `Drafted ${contractFile} from pinned routes and eight dataset schemas; review before accepting.`,
);
