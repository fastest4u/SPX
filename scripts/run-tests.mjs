import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
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
  ["admin-ui-e2e.test.ts", 240_000],
  ["user-ui-e2e.test.ts", 240_000],
  ["frontend-dashboard-clock-arrival-browser.test.ts", 180_000],
  ["frontend-metrics-observation-browser.test.ts", 180_000],
  ["frontend-dashboard-runtime-browser.test.ts", 180_000],
  ["frontend-provider-auth-browser.test.ts", 180_000],
  ["frontend-rule-review-browser.test.ts", 180_000],
  ["frontend-team-provider-auth-settings.test.ts", 180_000],
]);
const configuredTestTimeoutMs = Number.isInteger(Number(process.env.TEST_TIMEOUT_MS))
  ? Number(process.env.TEST_TIMEOUT_MS)
  : undefined;

const rawConcurrency = process.env.TEST_CONCURRENCY;
const parsedConcurrency = rawConcurrency !== undefined ? Number.parseInt(rawConcurrency, 10) : Number.NaN;
const defaultConcurrency = Math.max(1, Math.min(availableParallelism(), 4));
const maxConcurrency = Number.isInteger(parsedConcurrency) && parsedConcurrency >= 1
  ? parsedConcurrency
  : defaultConcurrency;

function isSerialBrowserSuite(file) {
  return browserTestTimeouts.has(file) || /(?:-browser|-ui-e2e)\.test\.tsx?$/.test(file);
}

const testFiles = readdirSync(testsDir)
  .filter((name) => /\.test\.tsx?$/.test(name))
  .filter((name) => (onlyArg ? name.includes(onlyArg) : true))
  .sort();

if (testFiles.length === 0) {
  console.error(onlyArg ? `No test files matched "${onlyArg}"` : "No *.test.ts or *.test.tsx files found in tests/");
  process.exit(1);
}

function runTest(file, { buffered = false } = {}) {
  return new Promise((resolveRun) => {
    const testTimeoutMs = configuredTestTimeoutMs ?? browserTestTimeouts.get(file) ?? DEFAULT_TEST_TIMEOUT_MS;
    const startedAt = Date.now();
    let settled = false;
    let exited = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    const child = spawn(process.execPath, ["--import", "tsx", join(testsDir, file)], {
      cwd: repoRoot,
      stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_MODE: "memory",
        SPX_TEST_SKIP_ENV_FILE: "1",
        SECRETS_KEY: "synthetic-standalone-test-key-32-characters",
      },
    });

    if (buffered) {
      child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    }

    const finalize = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({
        ...payload,
        stdout: buffered && stdoutChunks.length > 0 ? Buffer.concat(stdoutChunks) : null,
        stderr: buffered && stderrChunks.length > 0 ? Buffer.concat(stderrChunks) : null,
      });
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2_000).unref();
      finalize({
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

    child.on("close", (code, signal) => {
      exited = true;
      const durationMs = Date.now() - startedAt;
      finalize({ file, ok: code === 0 && !signal, code, signal, durationMs });
    });
    child.on("error", (error) => {
      finalize({ file, ok: false, code: null, signal: null, durationMs: Date.now() - startedAt, error });
    });
  });
}

function reportResult(result, { headerPrinted = false } = {}) {
  if (!headerPrinted) {
    console.log(`\n▶ ${result.file}`);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${result.ok ? "✓" : "✗"} ${status} ${result.file} (${result.durationMs}ms)`);
  if (result.error) {
    console.error(`  spawn error: ${result.error.message}`);
  }
  if (result.timedOut) {
    console.error(`  timed out after ${result.timeoutMs}ms`);
  }
}

async function runPool(files, concurrency) {
  if (concurrency <= 1 || files.length <= 1) {
    const out = [];
    for (const file of files) {
      console.log(`\n▶ ${file}`);
      const result = await runTest(file, { buffered: false });
      reportResult(result, { headerPrinted: true });
      out.push(result);
    }
    return out;
  }

  const out = new Array(files.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < files.length) {
        const index = cursor++;
        const file = files[index];
        const result = await runTest(file, { buffered: true });
        reportResult(result, { headerPrinted: false });
        out[index] = result;
      }
    }),
  );
  return out;
}

const parallelFiles = testFiles.filter((file) => !isSerialBrowserSuite(file));
const serialFiles = testFiles.filter((file) => isSerialBrowserSuite(file));

const results = [
  ...(await runPool(parallelFiles, maxConcurrency)),
  ...(await runPool(serialFiles, 1)),
];

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
