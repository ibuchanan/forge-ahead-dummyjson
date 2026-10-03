import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";
import ts from "typescript";
import {
  buildOperation,
  contractSemanticDrift,
  type ReviewedRoute,
} from "./contract-semantics";

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

const inventoryDocument: {
  sourceCommit: string;
  families: RouteInventory;
} = JSON.parse(readFileSync("specs/reviewed-routes.json", "utf8"));
const inventory = inventoryDocument.families;
const contractFile = "specs/dummyjson.openapi.json";
const sources = "vendor/DummyJSON/src/routes";
const fail = (message: string): never => {
  throw new Error(message);
};
function verifySourceCommit() {
  if (!existsSync(`${sources}/index.js`))
    fail(
      "Pinned DummyJSON source is not initialized. Run `git submodule update --init vendor/DummyJSON` and retry.",
    );
  const actual = (() => {
    try {
      return execFileSync(
        "git",
        ["-C", "vendor/DummyJSON", "rev-parse", "HEAD"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch {
      return fail(
        "Cannot read the pinned DummyJSON source commit. Run `git submodule update --init vendor/DummyJSON` and retry.",
      );
    }
  })();
  if (actual !== inventoryDocument.sourceCommit)
    fail(
      `Reviewed route inventory targets DummyJSON ${inventoryDocument.sourceCommit}, but the submodule is ${actual}. Review the source changes, then update specs/reviewed-routes.json.`,
    );
}
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
verifySourceCommit();
const sourcePaths = discover();
const reviewedPaths = reviewed();
compare(sourcePaths, new Set(reviewedPaths.keys()), "GET route coverage");

if (process.argv.includes("--check")) {
  const existing = JSON.parse(readFileSync(contractFile, "utf8")) as {
    paths: Record<string, unknown>;
  };
  const drift = contractSemanticDrift(reviewedPaths, existing.paths);
  if (drift.length)
    fail(
      `Contract semantic drift:\n${drift.map((item) => `- ${item}`).join("\n")}`,
    );
  console.log(`Contract semantics: ${reviewedPaths.size} routes agree`);
  process.exit(0);
}
if (!process.argv.includes("--draft"))
  fail("Usage: bun run contract:check | bun run generate:contract");

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
for (const [family, plural] of Object.entries(families)) {
  const draft =
    await $`node_modules/.bin/quicktype --lang schema --src vendor/DummyJSON/database/${plural}.json --top-level ${plural}Dataset --no-date-times`.json();
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
const paths: Record<string, unknown> = {};
for (const [path, route] of [...reviewedPaths].sort(([a], [b]) =>
  a.localeCompare(b),
))
  paths[path] = { get: buildOperation(path, route) };
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
