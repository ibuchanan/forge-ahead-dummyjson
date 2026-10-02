import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(resolve(packageRoot, "tmp_rovo_consumer_"));
const modules = resolve(fixture, "node_modules");
const link = resolve(modules, "@forge-ahead/dummyjson");

try {
  mkdirSync(resolve(modules, "@forge-ahead"), { recursive: true });
  symlinkSync(packageRoot, link, "dir");
  for (const file of ["consumer.ts", "consumer.mts"]) {
    copyFileSync(
      resolve(packageRoot, "test/fixtures/consumer-cjs/consumer.ts"),
      resolve(fixture, file),
    );
  }
  const require = createRequire(resolve(fixture, "consumer.cjs"));
  for (const entry of [
    require("@forge-ahead/dummyjson"),
    await import("@forge-ahead/dummyjson"),
  ]) {
    for (const name of [
      "createDummyJSONClient",
      "fetchRawPage",
      "planRemainingPages",
      "enqueueRemainingPages",
    ]) {
      if (typeof entry[name] !== "function") {
        throw new Error(`Missing ${name} in package entry`);
      }
    }
  }
  execFileSync(
    process.execPath,
    [
      resolve(packageRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      "--target",
      "ES2022",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      resolve(fixture, "consumer.ts"),
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      resolve(packageRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      resolve(fixture, "consumer.mts"),
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
