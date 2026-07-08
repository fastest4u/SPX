import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseRuntimeRole,
  parseRunTeamIds,
  requireNodeIdForDistributedRole,
  type RuntimeRole,
} from "../src/services/runtime-role.js";

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;
const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/config/env.ts")).href;

const passthroughEnvKeys = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
];

function runConfigValidation(overrides: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), "spx-runtime-role-config-"));
  const env: Record<string, string> = {
    NODE_ENV: "test",
    DB_MODE: "memory",
    API_URL: "https://spx.example.test/booking/bidding/list",
    APP_NAME: "spx-test",
    REFERER: "https://spx.example.test/",
  };

  for (const key of passthroughEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, overrides);

  const script = `
    const mod = await import(${JSON.stringify(envModuleUrl)});
    const validateRuntimeConfig = mod.validateRuntimeConfig ?? mod.default?.validateRuntimeConfig;
    console.log("IMPORTED");
    try {
      if (typeof validateRuntimeConfig !== "function") {
        throw new Error("validateRuntimeConfig export is unavailable");
      }
      validateRuntimeConfig();
      console.log("VALID");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(42);
    }
  `;

  try {
    return spawnSync(process.execPath, ["--import", tsxRegisterUrl, "-e", script], {
      cwd: tempDir,
      encoding: "utf8",
      env,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertConfigValidationFailure(overrides: Record<string, string>, expectedMessage: RegExp) {
  const result = runConfigValidation(overrides);
  assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /IMPORTED/);
  assert.match(result.stderr, expectedMessage);
  return result;
}

function assertConfigValidationSuccess(overrides: Record<string, string>) {
  const result = runConfigValidation(overrides);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /IMPORTED/);
  assert.match(result.stdout, /VALID/);
  return result;
}

assert.equal(parseRuntimeRole(undefined), "combined");
assert.equal(parseRuntimeRole("api"), "api");
assert.equal(parseRuntimeRole("worker"), "worker");
assert.equal(parseRuntimeRole("notifier"), "notifier");
assert.equal(parseRuntimeRole("combined"), "combined");

assert.throws(() => parseRuntimeRole("poller"), /SPX_ROLE/);

assert.deepEqual(parseRunTeamIds(undefined), []);
assert.deepEqual(parseRunTeamIds("1, 2,3"), [1, 2, 3]);
assert.deepEqual(parseRunTeamIds("2,2,3"), [2, 3]);
assert.throws(() => parseRunTeamIds("1,x"), /RUN_TEAM_IDS/);
assert.throws(() => parseRunTeamIds("0"), /RUN_TEAM_IDS/);

const roles: RuntimeRole[] = ["worker", "notifier"];
for (const role of roles) {
  assert.throws(() => requireNodeIdForDistributedRole(role, ""), /SPX_NODE_ID/);
}
assert.equal(requireNodeIdForDistributedRole("api", ""), null);
assert.equal(requireNodeIdForDistributedRole("combined", ""), null);
assert.equal(requireNodeIdForDistributedRole("worker", "ifn-worker-01"), "ifn-worker-01");

assertConfigValidationFailure({ SPX_ROLE: "poller" }, /SPX_ROLE/);
assertConfigValidationFailure({ RUN_TEAM_IDS: "1,x" }, /RUN_TEAM_IDS/);
assertConfigValidationFailure(
  {
    SPX_ROLE: "notifier",
    NOTIFIER_SHARED_SECRET: "shared-secret",
  },
  /SPX_NODE_ID/,
);
assertConfigValidationFailure(
  {
    SPX_ROLE: "notifier",
    SPX_NODE_ID: "   ",
    NOTIFIER_SHARED_SECRET: "shared-secret",
  },
  /SPX_NODE_ID/,
);
assertConfigValidationFailure(
  {
    SPX_ROLE: "notifier",
    SPX_NODE_ID: "ifn-notifier-01",
    NOTIFIER_SHARED_SECRET: "   ",
  },
  /NOTIFIER_SHARED_SECRET/,
);
assertConfigValidationFailure(
  {
    SPX_ROLE: "api",
    HTTP_ENABLED: "true",
    LINE_SERVICE_URL: "http://line-service:3003",
    LINE_SERVICE_ADMIN_SECRET: "admin-secret",
  },
  /LINE_SERVICE_SEND_SECRET/,
);

const workerMissingResult = assertConfigValidationFailure(
  {
    SPX_ROLE: "worker",
    SPX_NODE_ID: "   ",
    RUN_TEAM_IDS: "1",
    NOTIFIER_API_URL: "https://notifier.example.test/notify",
    NOTIFIER_SHARED_SECRET: "   ",
  },
  /SPX_NODE_ID/,
);
assert.match(workerMissingResult.stderr, /NOTIFIER_SHARED_SECRET/);

assertConfigValidationSuccess({});

assertConfigValidationSuccess({
  SPX_ROLE: "worker",
  SPX_NODE_ID: " ifn-worker-01 ",
  RUN_TEAM_IDS: "1,2",
  NOTIFIER_API_URL: "https://notifier.example.test/notify",
  NOTIFIER_SHARED_SECRET: "shared-secret",
});
