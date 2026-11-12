import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fixture = mkdtempSync(join(resolve("tests"), ".runner-concurrency-fixture-"));
try {
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "tests"));
  mkdirSync(join(fixture, "markers"));
  copyFileSync(resolve("scripts/run-tests.mjs"), join(fixture, "scripts/run-tests.mjs"));

  for (const id of ["alpha", "beta", "gamma"]) {
    writeFileSync(
      join(fixture, `tests/${id}.test.ts`),
      `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const startedAt = Date.now();
      setTimeout(() => {
        const endedAt = Date.now();
        writeFileSync(join(process.cwd(), "markers", "${id}.json"), JSON.stringify({ id: "${id}", startedAt, endedAt }));
        console.log("completed-${id}");
      }, 500);
      `,
    );
  }

  const baseEnv = Object.fromEntries(
    ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"].map((key) => [key, process.env[key]]),
  );

  const parallelRun = spawnSync(process.execPath, [join(fixture, "scripts/run-tests.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...baseEnv, TEST_CONCURRENCY: "3" },
  });

  assert.equal(parallelRun.status, 0, `${parallelRun.stdout}\n${parallelRun.stderr}`);
  assert.match(parallelRun.stdout, /completed-alpha/);
  assert.match(parallelRun.stdout, /completed-beta/);
  assert.match(parallelRun.stdout, /completed-gamma/);

  const windows = readdirSync(join(fixture, "markers"))
    .map((file) => JSON.parse(readFileSync(join(fixture, "markers", file), "utf8")) as {
      id: string;
      startedAt: number;
      endedAt: number;
    })
    .sort((a, b) => a.startedAt - b.startedAt);

  assert.equal(windows.length, 3);
  const hasOverlap =
    windows[1].startedAt < windows[0].endedAt ||
    windows[2].startedAt < windows[1].endedAt;
  assert.equal(
    hasOverlap,
    true,
    `Expected concurrent test execution with TEST_CONCURRENCY=3, got sequential windows: ${JSON.stringify(windows)}`,
  );

  console.log("test-runner-concurrency: parallel execution and buffered output verified");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
