import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { buildOperation } from "../scripts/contract-semantics";

const script = resolve(import.meta.dir, "../scripts/generate-contract.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dummyjson-contract-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "specs"), { recursive: true });
  return root;
}

function run(root: string) {
  return Bun.spawnSync(["bun", "run", script, "--check"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
}

it("verifies a reviewed source fixture and rejects an unreviewed commit", () => {
  const root = fixture();
  const source = join(root, "vendor/DummyJSON");
  const routes = join(source, "src/routes");
  mkdirSync(routes, { recursive: true });
  writeFileSync(
    join(routes, "index.js"),
    'router.use(["/product"], productRoutes);\n',
  );
  writeFileSync(join(routes, "product.js"), 'router.get("/", list);\n');
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Contract Fixture",
      "-c",
      "user.email=contract-fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: source },
  );
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(root, "specs/reviewed-routes.json"),
    JSON.stringify({
      sourceCommit,
      families: {
        product: { mounts: ["/product"], routes: [["/", "page", ""]] },
      },
    }),
  );
  const route = {
    family: "product",
    suffix: "/",
    shape: "page",
    query: "",
    responseFamily: "product",
  };
  writeFileSync(
    join(root, "specs/dummyjson.openapi.json"),
    JSON.stringify({
      paths: { "/product": { get: buildOperation("/product", route) } },
    }),
  );

  const result = run(root);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "Contract semantics: 1 routes agree",
  );

  writeFileSync(join(routes, "product.js"), 'router.get("/", changed);\n');
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Contract Fixture",
      "-c",
      "user.email=contract-fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "unreviewed fixture",
    ],
    { cwd: source },
  );

  const unreviewed = run(root);

  expect(unreviewed.exitCode).not.toBe(0);
  expect(unreviewed.stderr.toString()).toContain(
    "Review the source changes, then update specs/reviewed-routes.json",
  );
});

it("fails with remediation when the pinned source is not initialized", () => {
  const root = fixture();
  writeFileSync(
    join(root, "specs/reviewed-routes.json"),
    JSON.stringify({ sourceCommit: "abc", families: {} }),
  );

  const result = run(root);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "git submodule update --init vendor/DummyJSON",
  );
});
