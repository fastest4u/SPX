import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function run() {
  const runner = await import("../scripts/e2e-runner.mjs") as {
    e2eSuites: Array<{ name: string; file: string }>;
    buildE2eEnv: (baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    runE2e: (root: string, options: { spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; shell?: boolean }) => object; browserAvailable: () => boolean; env: NodeJS.ProcessEnv }) => number;
  };

  assert.deepEqual(
    runner.e2eSuites.map((suite) => suite.file),
    ["tests/admin-ui-e2e.test.ts", "tests/user-ui-e2e.test.ts"],
    "E2E runner should execute admin and standard-user browser suites",
  );

  const defaultEnv = runner.buildE2eEnv({});
  assert.equal(defaultEnv.SPX_TEST_SKIP_ENV_FILE, "1");
  assert.equal(defaultEnv.DB_MODE, "memory");
  assert.equal(defaultEnv.NODE_ENV, "test");
  const fenced = runner.buildE2eEnv({ API_URL: "https://unsafe.test", LINE_SERVICE_URL: "https://unsafe.test", SECRETS_KEY: "caller-secret", NODE_OPTIONS: "--require unsafe", VITE_API_BASE_URL: "https://unsafe.test" });
  assert.equal(fenced.LINE_SERVICE_URL, undefined);
  assert.equal(fenced.NODE_OPTIONS, undefined);
  assert.equal(fenced.VITE_API_BASE_URL, undefined);
  assert.notEqual(fenced.SECRETS_KEY, "caller-secret");
  assert.match(fenced.API_URL!, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(defaultEnv.RUN_E2E, "true");
  assert.equal(defaultEnv.E2E_HEADLESS, "true");

  const explicitEnv = runner.buildE2eEnv({ E2E_HEADLESS: "false" });
  assert.equal(explicitEnv.RUN_E2E, "true");
  assert.equal(explicitEnv.E2E_HEADLESS, "false");

  const calls: Array<{ args: string[]; options: { env: NodeJS.ProcessEnv; timeout: number; shell?: boolean } }> = [];
  const run = (results: Array<Record<string, unknown>>, available = true) => {
    calls.length = 0;
    return runner.runE2e(process.cwd(), {
      env: defaultEnv, browserAvailable: () => available,
      spawn: (_command, args, options) => { calls.push({ args, options }); return results.shift() ?? { status: 0 }; },
    });
  };
  assert.equal(run([]), 0);
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[0], /vite[\\/]bin[\\/]vite.js$/);
  assert.equal(calls[0].options.env.NODE_ENV, "production");
  assert.equal(calls[0].options.env.SPX_TEST_SKIP_ENV_FILE, "1");
  assert.deepEqual(calls.slice(1).map((call) => call.args.at(-1)), runner.e2eSuites.map((suite) => suite.file));
  for (const call of calls) { assert.ok(call.options.timeout > 0 && call.options.timeout <= 240_000); assert.notEqual(call.options.shell, true); }
  const diagnostics: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { diagnostics.push(args); };
  try {
  assert.equal(run([{ status: 7 }]), 7); assert.equal(calls.length, 1);
  assert.equal(run([{ status: 0 }, { status: 4 }]), 4); assert.equal(calls.length, 2);
  const timedOut = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100, killSignal: 'SIGKILL' });
  assert.equal((timedOut.error as NodeJS.ErrnoException).code, 'ETIMEDOUT');
  assert.equal(run([{ status: 0 }, timedOut]), 1); assert.equal(calls.length, 2);
  assert.equal(run([], false), 1); assert.equal(calls.length, 0);
    assert.equal(diagnostics.length, 4);
    assert.match(String(diagnostics[0][0]), /Fresh frontend build failed/);
    assert.equal(diagnostics[2][1], 'ETIMEDOUT');
    assert.match(String(diagnostics[3][0]), /Chromium is missing/);
  } finally { console.error = originalError; }


  console.log("e2e-runner test passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
