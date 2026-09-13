import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "spx-env-isolation-"));
try {
  writeFileSync(join(directory, ".env"), "SPX_SYNTHETIC_ENV_MARKER=from-synthetic-file\n");
  for (const [mode, flag, expected] of [
    ["test", "1", undefined],
    ["test", "0", "from-synthetic-file"],
    ["development", "1", "from-synthetic-file"],
  ] as const) {
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(require.resolve("tsx")).href, "--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(resolve("src/config/env.ts")).href)}); console.log(JSON.stringify({ marker: process.env.SPX_SYNTHETIC_ENV_MARKER }));`,
    ], {
      cwd: directory,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, NODE_ENV: mode, SPX_TEST_SKIP_ENV_FILE: flag },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), expected ? { marker: expected } : {}, `${mode}/${flag}: environment file loading contract`);
  }
  console.log("env-file-test-isolation.test.ts passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
