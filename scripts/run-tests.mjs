import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const testsDir = join(repoRoot, "tests");

/**
 * Lightweight test runner for the standalone tsx test scripts in tests/.
 * Each *.test.ts file is a self-contained executable that exits 0 on success
 * and non-zero on failure (via thrown assertions or process.exit(1)). We run
 * each in its own process so module singletons and process.chdir() calls in
 * one test cannot leak into another. Files that do not end in `.test.ts`
 * (e.g. live smoke scripts) are intentionally skipped.
 */

const onlyArg = process.argv[2];

const testFiles = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => (onlyArg ? name.includes(onlyArg) : true))
  .sort();

if (testFiles.length === 0) {
  console.error(onlyArg ? `No test files matched "${onlyArg}"` : "No *.test.ts files found in tests/");
  process.exit(1);
}

function runTest(file) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", join(testsDir, file)], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, DB_MODE: "memory" },
    });

    child.on("exit", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      resolveRun({ file, ok: code === 0 && !signal, code, signal, durationMs });
    });
    child.on("error", (error) => {
      resolveRun({ file, ok: false, code: null, signal: null, durationMs: Date.now() - startedAt, error });
    });
  });
}

const results = [];
for (const file of testFiles) {
  console.log(`\n▶ ${file}`);
  const result = await runTest(file);
  results.push(result);
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${result.ok ? "✓" : "✗"} ${status} ${file} (${result.durationMs}ms)`);
  if (result.error) {
    console.error(`  spawn error: ${result.error.message}`);
  }
}

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

console.log("\n──────────────────────────────────────────");
console.log(`Tests: ${passed.length} passed, ${failed.length} failed, ${results.length} total`);
if (failed.length > 0) {
  console.log("Failed:");
  for (const result of failed) {
    console.log(`  - ${result.file}${result.signal ? ` (signal ${result.signal})` : ` (exit ${result.code})`}`);
  }
  process.exit(1);
}
