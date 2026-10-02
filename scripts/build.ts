import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg: {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} = JSON.parse(readFileSync("package.json", "utf8"));

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

rmSync("dist", { recursive: true, force: true });

for (const format of ["esm", "cjs"] as const) {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "dist",
    target: "node",
    format,
    external,
    sourcemap: "external",
    naming: `index.${format === "esm" ? "mjs" : "cjs"}`,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

execFileSync(
  "node_modules/.bin/tsc",
  [
    "--declaration",
    "--emitDeclarationOnly",
    "--outDir",
    "dist",
    "--module",
    "ES2022",
    "--moduleResolution",
    "bundler",
    "--target",
    "ES2022",
    "--skipLibCheck",
    "src/index.ts",
  ],
  { stdio: "inherit" },
);
// Node16/NodeNext ESM resolution requires explicit extensions on relative
// specifiers in .d.mts files; a bare "./generated" only resolves under the
// more lenient CJS-style resolution. Split generated.d.ts into matching
// dual-format companions and point each index declaration at its own.
copyFileSync("dist/generated.d.ts", "dist/generated.d.mts");
copyFileSync("dist/generated.d.ts", "dist/generated.d.cts");
rmSync("dist/generated.d.ts");

const indexDts = readFileSync("dist/index.d.ts", "utf8");
writeFileSync(
  "dist/index.d.mts",
  indexDts.replace('"./generated"', '"./generated.mjs"'),
);
writeFileSync(
  "dist/index.d.cts",
  indexDts.replace('"./generated"', '"./generated.cjs"'),
);
rmSync("dist/index.d.ts");
