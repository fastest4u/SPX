import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const testsDir = join(repoRoot, "tests");

process.env.NODE_ENV = "test";
process.env.DB_MODE = "memory";

/**
 * Lightweight test runner for the standalone tsx test scripts in tests/.
 * Each *.test.ts or *.test.tsx file is a self-contained executable that exits 0 on success
 * and non-zero on failure (via thrown assertions or process.exit(1)). We run
 * each in its own process so module singletons and process.chdir() calls in
 * one test cannot leak into another. Files that do not end in `.test.ts` or `.test.tsx`
 * (e.g. live smoke scripts) are intentionally skipped.
 */

const onlyArg = process.argv[2];
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
// Browser suites include a cold Vite compile, bounded polling scenarios and
// browser/server cleanup. Keep ordinary test deadlines short.
const browserTestTimeouts = new Map([
  ["frontend-provider-auth-browser.test.ts", 180_000],
  ["frontend-rule-review-browser.test.ts", 180_000],
  ["frontend-team-provider-auth-settings.test.ts", 180_000],
]);
const configuredTestTimeoutMs = Number.isInteger(Number(process.env.TEST_TIMEOUT_MS))
  ? Number(process.env.TEST_TIMEOUT_MS)
  : undefined;

const testFiles = readdirSync(testsDir)
  .filter((name) => /\.test\.tsx?$/.test(name))
  .filter((name) => (onlyArg ? name.includes(onlyArg) : true))
  .sort();

if (testFiles.length === 0) {
  console.error(onlyArg ? `No test files matched "${onlyArg}"` : "No *.test.ts or *.test.tsx files found in tests/");
  process.exit(1);
}

function runTest(file) {
  return new Promise((resolveRun) => {
    const testTimeoutMs = configuredTestTimeoutMs ?? browserTestTimeouts.get(file) ?? DEFAULT_TEST_TIMEOUT_MS;
    const startedAt = Date.now();
    let settled = false;
    let exited = false;
    const child = spawn(process.execPath, ["--import", "tsx", join(testsDir, file)], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "test", DB_MODE: "memory" },
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2_000).unref();
      resolveRun({
        file,
        ok: false,
        code: null,
        signal: "TIMEOUT",
        durationMs: Date.now() - startedAt,
        timedOut: true,
        timeoutMs: testTimeoutMs,
      });
    }, testTimeoutMs);
    timeout.unref();

    child.on("exit", (code, signal) => {
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      resolveRun({ file, ok: code === 0 && !signal, code, signal, durationMs });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
  if (result.timedOut) {
    console.error(`  timed out after ${result.timeoutMs}ms`);
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
