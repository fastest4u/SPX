import assert from "node:assert/strict";

async function run() {
  const runner = await import("../scripts/e2e-runner.mjs") as {
    e2eSuites: Array<{ name: string; file: string }>;
    buildE2eEnv: (baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  };

  assert.deepEqual(
    runner.e2eSuites.map((suite) => suite.file),
    ["tests/admin-ui-e2e.test.ts", "tests/user-ui-e2e.test.ts"],
    "E2E runner should execute admin and standard-user browser suites",
  );

  const defaultEnv = runner.buildE2eEnv({});
  assert.equal(defaultEnv.RUN_E2E, "true");
  assert.equal(defaultEnv.E2E_HEADLESS, "true");

  const explicitEnv = runner.buildE2eEnv({ E2E_HEADLESS: "false" });
  assert.equal(explicitEnv.RUN_E2E, "true");
  assert.equal(explicitEnv.E2E_HEADLESS, "false");

  console.log("e2e-runner test passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
