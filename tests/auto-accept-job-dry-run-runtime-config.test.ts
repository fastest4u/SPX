import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { env } from "../src/config/env.js";
import { APP_SETTING_KEYS, PROCESS_ENV_KEYS } from "../src/config/config-catalog.js";

function runValidation(overrides: Record<string, string | undefined>) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      [
        "import { validateRuntimeConfig } from './src/config/env.ts';",
        "try { validateRuntimeConfig(); process.exit(0); }",
        "catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }",
      ].join(" "),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_MODE: "memory",
        DB_HOST: "mysql.example.test",
        DB_PORT: "3306",
        DB_USERNAME: "spx-runtime-user",
        DB_PASSWORD: "runtime-db-secret-value",
        DB_NAME: "spx_runtime",
        SPX_ROLE: "worker",
        SPX_NODE_ID: "dry-worker-01",
        RUN_TEAM_IDS: "2",
        API_URL: "https://spx.example.test/booking/bidding/list",
        APP_NAME: "SPX Test",
        REFERER: "https://spx.example.test/",
        NOTIFIER_API_URL: "http://notification-service.test/internal/notification-events",
        NOTIFIER_SHARED_SECRET: "notifier-secret-value",
        HTTP_ENABLED: "false",
        AUTO_ACCEPT_ENABLED: "false",
        AUTO_ACCEPT_JOB_SHADOW_ENABLED: "false",
        AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "true",
        AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS: "1000",
        AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE: "10",
        AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS: "300000",
        AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false",
        AUTO_ACCEPT_JOB_REAL_INTERVAL_MS: "1000",
        AUTO_ACCEPT_JOB_REAL_BATCH_SIZE: "10",
        AUTO_ACCEPT_JOB_REAL_LEASE_MS: "300000",
        AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false",
        AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS: "1000",
        AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE: "10",
        AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS: "300000",
        AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "false",
        AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: "",
        AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "false",
        AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: "",
        LINE_SERVICE_URL: "",
        OCR_SERVICE_URL: "",
        ...overrides,
      },
      encoding: "utf8",
    },
  );
  return {
    status: child.status,
    output: `${child.stdout}\n${child.stderr}`,
  };
}

assert.equal(env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED, false);
assert.equal(env.AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS, 1000);
assert.equal(env.AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE, 10);
assert.equal(env.AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS, 300_000);
assert.equal(env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED, false);
assert.equal(env.AUTO_ACCEPT_JOB_REAL_INTERVAL_MS, 1000);
assert.equal(env.AUTO_ACCEPT_JOB_REAL_BATCH_SIZE, 10);
assert.equal(env.AUTO_ACCEPT_JOB_REAL_LEASE_MS, 300_000);
assert.equal(env.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED, false);
assert.equal(env.AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS, 1000);
assert.equal(env.AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE, 10);
assert.equal(env.AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS, 300_000);
assert.equal(env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED, false);
assert.deepEqual(env.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS, []);
assert.equal(env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED, false);
assert.deepEqual(env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS, []);

const processEnvKeys = PROCESS_ENV_KEYS as readonly string[];
const appSettingKeys = APP_SETTING_KEYS as readonly string[];
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_REAL_INTERVAL_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_REAL_BATCH_SIZE"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_REAL_LEASE_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED"), true);
assert.equal(processEnvKeys.includes("AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS"), true);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED"), false);
assert.equal(appSettingKeys.includes("AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS"), false);

assert.equal(runValidation({}).status, 0);

const invalidBoolean = runValidation({ AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "maybe" });
assert.notEqual(invalidBoolean.status, 0);
assert.match(invalidBoolean.output, /AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED must be true or false/);

const invalidInterval = runValidation({ AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS: "0" });
assert.notEqual(invalidInterval.status, 0);
assert.match(invalidInterval.output, /AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS must be a positive integer/);

const invalidBatchSize = runValidation({ AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE: "0" });
assert.notEqual(invalidBatchSize.status, 0);
assert.match(invalidBatchSize.output, /AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE must be a positive integer/);

const invalidLease = runValidation({ AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS: "0" });
assert.notEqual(invalidLease.status, 0);
assert.match(invalidLease.output, /AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS must be a positive integer/);

const invalidRealBoolean = runValidation({ AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "maybe" });
assert.notEqual(invalidRealBoolean.status, 0);
assert.match(invalidRealBoolean.output, /AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED must be true or false/);

const invalidRealInterval = runValidation({ AUTO_ACCEPT_JOB_REAL_INTERVAL_MS: "0" });
assert.notEqual(invalidRealInterval.status, 0);
assert.match(invalidRealInterval.output, /AUTO_ACCEPT_JOB_REAL_INTERVAL_MS must be a positive integer/);

const invalidRealBatchSize = runValidation({ AUTO_ACCEPT_JOB_REAL_BATCH_SIZE: "0" });
assert.notEqual(invalidRealBatchSize.status, 0);
assert.match(invalidRealBatchSize.output, /AUTO_ACCEPT_JOB_REAL_BATCH_SIZE must be a positive integer/);

const invalidRealLease = runValidation({ AUTO_ACCEPT_JOB_REAL_LEASE_MS: "0" });
assert.notEqual(invalidRealLease.status, 0);
assert.match(invalidRealLease.output, /AUTO_ACCEPT_JOB_REAL_LEASE_MS must be a positive integer/);

const invalidSettlementBoolean = runValidation({ AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "maybe" });
assert.notEqual(invalidSettlementBoolean.status, 0);
assert.match(invalidSettlementBoolean.output, /AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED must be true or false/);

const invalidSettlementInterval = runValidation({ AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS: "0" });
assert.notEqual(invalidSettlementInterval.status, 0);
assert.match(invalidSettlementInterval.output, /AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS must be a positive integer/);

const invalidSettlementBatchSize = runValidation({ AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE: "0" });
assert.notEqual(invalidSettlementBatchSize.status, 0);
assert.match(invalidSettlementBatchSize.output, /AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE must be a positive integer/);

const invalidSettlementLease = runValidation({ AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS: "0" });
assert.notEqual(invalidSettlementLease.status, 0);
assert.match(invalidSettlementLease.output, /AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS must be a positive integer/);

const invalidCutoverBoolean = runValidation({ AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "maybe" });
assert.notEqual(invalidCutoverBoolean.status, 0);
assert.match(invalidCutoverBoolean.output, /AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED must be true or false/);

const missingCutoverTeams = runValidation({ AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "true" });
assert.notEqual(missingCutoverTeams.status, 0);
assert.match(
  missingCutoverTeams.output,
  /AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS must be set when AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED=true/,
);

const invalidCutoverTeams = runValidation({
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "true",
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: "abc",
});
assert.notEqual(invalidCutoverTeams.status, 0);
assert.match(invalidCutoverTeams.output, /AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS must contain positive integer team ids/);

const invalidFastAcceptAllCutoverBoolean = runValidation({ AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "maybe" });
assert.notEqual(invalidFastAcceptAllCutoverBoolean.status, 0);
assert.match(
  invalidFastAcceptAllCutoverBoolean.output,
  /AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED must be true or false/,
);

const missingFastAcceptAllCutoverTeams = runValidation({
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "true",
});
assert.notEqual(missingFastAcceptAllCutoverTeams.status, 0);
assert.match(
  missingFastAcceptAllCutoverTeams.output,
  /AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS must be set when AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED=true/,
);

const invalidFastAcceptAllCutoverTeams = runValidation({
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "true",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: "abc",
});
assert.notEqual(invalidFastAcceptAllCutoverTeams.status, 0);
assert.match(
  invalidFastAcceptAllCutoverTeams.output,
  /AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS must contain positive integer team ids/,
);

const wrongFastAcceptAllCutoverRole = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "true",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: "2",
  SPX_ROLE: "api",
});
assert.notEqual(wrongFastAcceptAllCutoverRole.status, 0);
assert.match(
  wrongFastAcceptAllCutoverRole.output,
  /AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED requires SPX_ROLE=poller-service, worker, or combined/,
);

const missingTeamScope = runValidation({ RUN_TEAM_IDS: "" });
assert.notEqual(missingTeamScope.status, 0);
assert.match(missingTeamScope.output, /RUN_TEAM_IDS must be set when AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED=true/);

const wrongRole = runValidation({ SPX_ROLE: "api" });
assert.notEqual(wrongRole.status, 0);
assert.match(
  wrongRole.output,
  /AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED requires SPX_ROLE=auto-accept-service, worker, or combined/,
);

const realWorkerEnabled = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
});
assert.equal(realWorkerEnabled.status, 0);

const missingRealTeamScope = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
  RUN_TEAM_IDS: "",
});
assert.notEqual(missingRealTeamScope.status, 0);
assert.match(missingRealTeamScope.output, /RUN_TEAM_IDS must be set when AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED=true/);

const wrongRealRole = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
  SPX_ROLE: "api",
});
assert.notEqual(wrongRealRole.status, 0);
assert.match(
  wrongRealRole.output,
  /AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED requires SPX_ROLE=auto-accept-service, worker, or combined/,
);

const settlementWorkerEnabled = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true",
});
assert.equal(settlementWorkerEnabled.status, 0);

const missingSettlementTeamScope = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true",
  RUN_TEAM_IDS: "",
});
assert.notEqual(missingSettlementTeamScope.status, 0);
assert.match(
  missingSettlementTeamScope.output,
  /RUN_TEAM_IDS must be set when AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED=true/,
);

const wrongSettlementRole = runValidation({
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "true",
  SPX_ROLE: "api",
});
assert.notEqual(wrongSettlementRole.status, 0);
assert.match(
  wrongSettlementRole.output,
  /AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED requires SPX_ROLE=auto-accept-service, worker, or combined/,
);

const conflictingWorkers = runValidation({ AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true" });
assert.notEqual(conflictingWorkers.status, 0);
assert.match(
  conflictingWorkers.output,
  /AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED and AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED cannot both be true/,
);

const appSource = readFileSync(resolve(process.cwd(), "src/app.ts"), "utf8");
assert.match(appSource, /startAutoAcceptJobDryRunWorkerLoop/);
assert.match(appSource, /startAutoAcceptJobRealWorkerLoop/);
assert.match(appSource, /startAutoAcceptJobSettlementWorkerLoop/);
assert.match(appSource, /autoAcceptDryRunWorkerLoop\?\.stop\(\)/);
assert.match(appSource, /autoAcceptRealWorkerLoop\?\.stop\(\)/);
assert.match(appSource, /autoAcceptSettlementWorkerLoop\?\.stop\(\)/);
assert.ok(
  appSource.indexOf("env.AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED") <
    appSource.indexOf("await migrateJsonToDb()"),
  "dry-run worker flag should participate in startup migration gating",
);
assert.ok(
  appSource.indexOf("env.AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED") <
    appSource.indexOf("await migrateJsonToDb()"),
  "real worker flag should participate in startup migration gating",
);
assert.ok(
  appSource.indexOf("env.AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED") <
    appSource.indexOf("await migrateJsonToDb()"),
  "settlement worker flag should participate in startup migration gating",
);
assert.ok(
  appSource.indexOf("autoAcceptDryRunWorkerLoop = startAutoAcceptJobDryRunWorkerLoop") <
    appSource.indexOf("await manager.startAllEnabledTeams()"),
  "dry-run worker loop should be wired before worker runtime teams start polling",
);
assert.ok(
  appSource.indexOf("autoAcceptRealWorkerLoop = startAutoAcceptJobRealWorkerLoop") <
    appSource.indexOf("await manager.startAllEnabledTeams()"),
  "real worker loop should be wired before worker runtime teams start polling",
);
assert.ok(
  appSource.indexOf("autoAcceptSettlementWorkerLoop = startAutoAcceptJobSettlementWorkerLoop") <
    appSource.indexOf("await manager.startAllEnabledTeams()"),
  "settlement worker loop should be wired before worker runtime teams start polling",
);
