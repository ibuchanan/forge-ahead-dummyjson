import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const directory = mkdtempSync("tmp_rovo_types_");
try {
  const output = join(directory, "generated.ts");
  execFileSync(
    "npm",
    [
      "exec",
      "--no",
      "--",
      "openapi-typescript",
      "specs/dummyjson.openapi.json",
      "-o",
      output,
    ],
    { stdio: "pipe" },
  );
  if (
    readFileSync(output, "utf8") !== readFileSync("src/generated.ts", "utf8")
  ) {
    throw new Error(
      "Generated endpoint types are stale; run npm run generate:types",
    );
  }
  console.log("Generated endpoint types match the reviewed contract.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
