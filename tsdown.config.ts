import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "./src/lib/index.ts",
    },
    outDir: "./dist",
    format: ["esm", "cjs"],
    sourcemap: true,
    target: "node22",
  },
  {
    entry: {
      "check-consumer": "./src/scripts/check-consumer.ts",
      "check-generated": "./src/scripts/check-generated.ts",
      "generate-contract": "./src/scripts/generate-contract.ts",
    },
    outDir: "./scripts",
    format: ["esm"],
    // Only remove the files this config generates; scripts/release-prepare.sh
    // is a hand-written shell script that also lives in this directory.
    clean: [
      "scripts/check-consumer.mjs",
      "scripts/check-generated.mjs",
      "scripts/generate-contract.mjs",
    ],
    dts: false,
    sourcemap: false,
    target: "node22",
    platform: "node",
    deps: {
      neverBundle: ["typescript"],
    },
  },
]);
