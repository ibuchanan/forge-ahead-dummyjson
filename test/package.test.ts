import { builtinModules } from "node:module";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "bun:test";

const root = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(root, "tmp_rovo_package-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function run(args: string[], cwd = fixture) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
  });
  expect(
    result.exitCode,
    `${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
}

it("installs and bundles the packed root without Forge, and resolves both entry points in ESM/CommonJS", async () => {
  run(["run", "build"], root);
  const tarball = join(fixture, "tmp_rovo_dummyjson.tgz");
  run(["pm", "pack", "--ignore-scripts", "--filename", tarball], root);
  const consumer = {
    name: "tmp_rovo_consumer",
    private: true,
    type: "module",
    dependencies: { "@forge-ahead/dummyjson": tarball },
  };
  await Bun.write(join(fixture, "package.json"), JSON.stringify(consumer));
  // Reuse pinned resolutions, not installed modules: fresh git dependency
  // resolution needs the network even when its pinned checkout is cached.
  const { parseConfigFileTextToJson } = await import("typescript");
  const { config: lock } = parseConfigFileTextToJson(
    "bun.lock",
    await Bun.file(join(root, "bun.lock")).text(),
  );
  lock.workspaces = {
    "": { name: consumer.name, dependencies: consumer.dependencies },
  };
  const manifest = await Bun.file(join(root, "package.json")).json();
  const packages = lock.packages;
  lock.packages = {};
  async function includeDependency(name: string) {
    if (lock.packages[name]) return;
    lock.packages[name] = packages[name];
    const dependency = await Bun.file(
      join(root, "node_modules", name, "package.json"),
    ).json();
    for (const child of Object.keys(dependency.dependencies ?? {}))
      await includeDependency(child);
  }
  for (const name of Object.keys(manifest.dependencies))
    await includeDependency(name);
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(await Bun.file(tarball).arrayBuffer()).digest("base64")}`;
  lock.packages["@forge-ahead/dummyjson"] = [
    `@forge-ahead/dummyjson@${tarball}`,
    {
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
      optionalPeers: Object.keys(manifest.peerDependenciesMeta).filter(
        (name) => manifest.peerDependenciesMeta[name].optional,
      ),
    },
    integrity,
  ];
  await Bun.write(join(fixture, "bun.lock"), JSON.stringify(lock));
  run(["install", "--offline", "--ignore-scripts"]);
  // --ignore-scripts skips this Git dependency's prepare build. Supply only its
  // already-built dist; all packages above were installed in the fresh fixture.
  cpSync(
    join(root, "node_modules/@forge-ahead/errors/dist"),
    join(fixture, "node_modules/@forge-ahead/errors/dist"),
    { recursive: true },
  );
  expect(existsSync(join(fixture, "node_modules/@forge/api"))).toBe(false);
  expect(existsSync(join(fixture, "node_modules/@types/node"))).toBe(false);

  const usage = `
const client = createDummyJSONClient(async (request) => {
  if (request.method !== "GET" || request.url !== "https://dummyjson.com/products?limit=1") throw new Error("wrong request");
  return Response.json({ products: [{ id: 42, title: "Desk" }], total: 2, skip: 0, limit: 1 });
});
async function check() {
  const page = await fetchRawPage(
    ({ skip, limit }) => client.GET("/products", { params: { query: { limit } } }),
    "products", { skip: 0, limit: 1 },
  );
  if (!page.isOk() || page.value.records[0].id !== 42) throw new Error("wrong page");
  const plan = createRemainingPages(page.value);
  if (!plan.isOk()) throw new Error("wrong plan");
  const result = await plan.value.enqueue({ push: async (events) => {
    if (events.length !== 1 || events[0].body.skip !== 1) throw new Error("wrong offset");
    return { jobId: "offline" };
  } }, (offset) => ({ body: offset }), { maxEvents: 1 });
  if (!result.isOk()) throw new Error("wrong continuation");
}
`;
  for (const format of ["mjs", "cjs"]) {
    const imports =
      format === "mjs"
        ? 'import { createDummyJSONClient, fetchRawPage, createRemainingPages } from "@forge-ahead/dummyjson";'
        : 'const { createDummyJSONClient, fetchRawPage, createRemainingPages } = require("@forge-ahead/dummyjson");';
    const file = join(fixture, `tmp_rovo_root.${format}`);
    await Bun.write(
      file,
      `${imports}\n${usage}\ncheck().catch((error) => { throw error; });`,
    );
    run(["run", file]);
  }

  const browserEntry = join(fixture, "tmp_rovo_browser.ts");
  await Bun.write(
    browserEntry,
    `
import { createDummyJSONClient, fetchRawPage, createRemainingPages } from "@forge-ahead/dummyjson";
export const client = createDummyJSONClient((request) => globalThis.fetch(request));
export { fetchRawPage, createRemainingPages };
`,
  );
  const forbidden = new Set(
    builtinModules.flatMap((name) => [name, `node:${name}`]),
  );
  const bundle = await Bun.build({
    entrypoints: [browserEntry],
    target: "browser",
    metafile: true,
    plugins: [
      {
        name: "reject-backend-modules",
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path }) => {
            if (path.startsWith("@forge/") || forbidden.has(path))
              throw new Error(`Backend import in browser: ${path}`);
            return undefined;
          });
        },
      },
    ],
  });
  expect(bundle.success, bundle.logs.join("\n")).toBe(true);
  const inputs = Object.keys(bundle.metafile?.inputs ?? {});
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.some((path) => /node_modules\/@forge\//.test(path))).toBe(
    false,
  );

  const compiler = join(root, "node_modules/typescript/bin/tsc");
  async function typecheck(
    name: string,
    source: string,
    options: Record<string, unknown>,
  ) {
    const entry = `tmp_rovo_${name}.ts`;
    await Bun.write(join(fixture, entry), source);
    const config = join(fixture, `tmp_rovo_${name}.json`);
    await Bun.write(
      config,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          ...options,
        },
        files: [entry],
      }),
    );
    run(["run", compiler, "-p", config]);
  }
  const typedUsage = `
import { createDummyJSONClient, fetchRawPage, createRemainingPages } from "@forge-ahead/dummyjson";
const client = createDummyJSONClient((request) => globalThis.fetch(request));
async function check() {
  const result = await client.GET("/products/{id}", { params: { path: { id: 42 } } });
  if (result.isOk()) { const title: string | undefined = result.value.title; }
}
// @ts-expect-error root transport is required
createDummyJSONClient();
// @ts-expect-error detail path parameters are required
client.GET("/products/{id}");
// @ts-expect-error only GET is exposed
client.POST("/products");
void fetchRawPage; void createRemainingPages;
`;
  await typecheck("browser", typedUsage, {
    module: "ES2022",
    moduleResolution: "bundler",
    skipLibCheck: false,
  });

  // Only the adapter fixture supplies a host package; the root checks above have none.
  const forgeDir = join(fixture, "node_modules/@forge/api");
  await Bun.write(
    join(forgeDir, "package.json"),
    JSON.stringify({ name: "@forge/api", version: "8.2.0", main: "index.cjs" }),
  );
  await Bun.write(
    join(forgeDir, "index.cjs"),
    `
module.exports = { fetch: async (url, options) => {
  if (url !== "https://dummyjson.com/products/42" || options.method !== "GET" || options.headers["x-example"] !== "packed" || !options.signal) throw new Error("wrong Forge mapping");
  return Response.json({ id: 42 });
} };
`,
  );
  const bothEntries = `${typedUsage}\nimport { createDummyJSONClient as forgeClient } from "@forge-ahead/dummyjson/forge";\nvoid forgeClient().GET("/products");`;
  // The existing errors dependency has extensionless ESM declaration imports.
  // Browser/bundler and legacy CommonJS fixtures check declarations fully.
  await typecheck("esm", bothEntries, {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    skipLibCheck: true,
  });
  await typecheck("commonjs", bothEntries, {
    module: "CommonJS",
    moduleResolution: "Node",
    skipLibCheck: false,
  });
  for (const format of ["mjs", "cjs"]) {
    const imports =
      format === "mjs"
        ? 'import { createDummyJSONClient } from "@forge-ahead/dummyjson/forge";'
        : 'const { createDummyJSONClient } = require("@forge-ahead/dummyjson/forge");';
    const file = join(fixture, `tmp_rovo_forge.${format}`);
    await Bun.write(
      file,
      `${imports}\ncreateDummyJSONClient().GET("/products/{id}", { params: { path: { id: 42 } }, headers: { "X-Example": "packed" } }).then((result) => {
      if (!result.isOk() || result.value.id !== 42) throw new Error("wrong Forge result");
    });`,
    );
    run(["run", file]);
  }
}, 60000);
