import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const tsxRegisterUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const ownedFixture = mkdtempSync(join(tmpdir(), "spx-dedicated-runtime-config-"));
process.on("exit", () => rmSync(ownedFixture, { recursive: true, force: true }));
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const notificationNodeSecret = "notification-node-secret-value-at-least-32-chars";
const ocrLineNodeSecret = "ocr-line-node-secret-value-at-least-32-characters";
const ocrAdminNodeSecret = "ocr-admin-node-secret-value-at-least-32-characters";
const gate6ControlNodeSecret = "gate6-control-node-secret-value-at-least-32-chars";

const productionOcrBoundary = {
  OCR_NODE_SECRETS: `line-production-01=${ocrLineNodeSecret},web-production-01=${ocrAdminNodeSecret}`,
  OCR_ALLOWED_LINE_NODE_IDS: "line-production-01",
  OCR_ADMIN_NODE_IDS: "web-production-01",
  OCR_REPLAY_LEDGER_DIR: "/app/data/internal-replay",
  GATE6_CONTROL_NODE_SECRET: gate6ControlNodeSecret,
  GATE6_OCR_PERMIT_KEY_ID: "gate6-ocr-permit-v1",
  GATE6_OCR_PERMIT_PUBLIC_KEY_FILE: "/run/secrets/gate6-ocr-permit-public-key.pem",
} as const;

const baseConfig = {
  NODE_ENV: "test",
  SECRETS_KEY: "test-secrets-key-with-at-least-32-characters",
  DB_MODE: "memory",
  DB_HOST: "mysql.example.test",
  DB_PORT: "3306",
  DB_USERNAME: "spx-runtime-user",
  DB_PASSWORD: "runtime-db-secret-value",
  DB_NAME: "spx_runtime",
  SPX_ROLE: "worker",
  SPX_NODE_ID: "worker-01",
  RUN_TEAM_IDS: "2",
  API_URL: "https://spx.example.test/booking/bidding/list",
  APP_NAME: "SPX Test",
  REFERER: "https://spx.example.test/",
  NOTIFIER_API_URL: "http://notification-service.test/internal/notification-events",
  NOTIFIER_SHARED_SECRET: "notifier-secret-value",
  NOTIFICATION_NODE_SECRET: notificationNodeSecret,
  HTTP_ENABLED: "false",
  AUTO_ACCEPT_ENABLED: "false",
  AUTO_ACCEPT_JOB_SHADOW_ENABLED: "false",
  AUTO_ACCEPT_JOB_CUTOVER_EPOCH: "",
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "true",
  AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED: "false",
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: "false",
  AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: "",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: "false",
  AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: "",
  LINE_SERVICE_URL: "",
  OCR_SERVICE_URL: "",
  OCR_SERVICE_ADMIN_SECRET: "ocr-admin-secret-value",
} as const;

function runValidation(overrides: Record<string, string | undefined>) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      tsxRegisterUrl,
      "--eval",
      [
        `import { validateRuntimeConfig } from ${JSON.stringify(pathToFileURL(resolve("src/config/env.ts")).href)};`,
        "try { validateRuntimeConfig(); process.exit(0); }",
        "catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }",
      ].join(" "),
    ],
    {
      cwd: ownedFixture,
      env: { ...Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"].map((key) => [key, process.env[key]])), ...baseConfig, ...overrides },
      encoding: "utf8",
    },
  );
  return {
    status: child.status,
    output: `${child.stdout}\n${child.stderr}`,
  };
}

const redactedValues = [
  baseConfig.DB_PASSWORD,
  baseConfig.NOTIFIER_SHARED_SECRET,
  gate6ControlNodeSecret,
];

function assertFailure(overrides: Record<string, string | undefined>, expected: RegExp) {
  const result = runValidation(overrides);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, expected);
  for (const value of redactedValues) assert.doesNotMatch(result.output, new RegExp(value));
  return result;
}

function assertSuccess(overrides: Record<string, string | undefined>) {
  const result = runValidation(overrides);
  assert.equal(result.status, 0, result.output);
  for (const value of redactedValues) assert.doesNotMatch(result.output, new RegExp(value));
}

function dedicatedRoleConfig(role: "poller-service" | "auto-accept-service") {
  return {
    SPX_ROLE: role,
    SPX_NODE_ID: role === "poller-service" ? "poller-01" : "auto-accept-01",
    RUN_TEAM_IDS: "2",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED:
      role === "auto-accept-service" ? "true" : "false",
    ...(role === "poller-service"
      ? { AUTO_ACCEPT_JOB_CUTOVER_EPOCH: "phase3-ifn-20260710" }
      : {}),
  };
}

for (const role of ["poller-service", "auto-accept-service"] as const) {
  const valid = dedicatedRoleConfig(role);
  assertSuccess(valid);

  assertFailure(
    { ...valid, RUN_TEAM_IDS: "" },
    new RegExp(`RUN_TEAM_IDS must be set when SPX_ROLE=${role}`),
  );

  const missingDistributedPrerequisites = assertFailure(
    {
      ...valid,
      SPX_NODE_ID: "",
      API_URL: "",
      APP_NAME: "",
      REFERER: "",
      NOTIFIER_API_URL: "",
      NOTIFIER_SHARED_SECRET: "",
    },
    /SPX_NODE_ID/,
  );
  for (const requiredKey of [
    "SPX_NODE_ID",
    "API_URL",
    "APP_NAME",
    "REFERER",
    "NOTIFIER_API_URL",
    "NOTIFIER_SHARED_SECRET",
  ]) {
    assert.match(missingDistributedPrerequisites.output, new RegExp(requiredKey));
  }

  const missingDatabase = assertFailure(
    {
      ...valid,
      NODE_ENV: "production",
      DB_MODE: "mysql",
      DB_HOST: "",
      DB_USERNAME: "",
      DB_PASSWORD: "",
      DB_NAME: "",
    },
    /DB_HOST/,
  );
  for (const requiredKey of ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "DB_NAME"]) {
    assert.match(missingDatabase.output, new RegExp(requiredKey));
  }

  assertFailure(
    {
      ...valid,
      NODE_ENV: "production",
      DB_MODE: "memory",
    },
    new RegExp(`DB_MODE=memory is not allowed for production SPX_ROLE=${role}`),
  );

  assertFailure(
    { ...valid, HTTP_ENABLED: "true" },
    /HTTP_ENABLED cannot be true for a headless SPX_ROLE/,
  );
}

assertFailure(
  {
    ...dedicatedRoleConfig("poller-service"),
    AUTO_ACCEPT_JOB_CUTOVER_EPOCH: "",
  },
  /SPX_ROLE=poller-service requires AUTO_ACCEPT_JOB_CUTOVER_EPOCH/,
);
assertFailure(
  {
    ...dedicatedRoleConfig("poller-service"),
    AUTO_ACCEPT_JOB_CUTOVER_EPOCH: " phase3-invalid ",
  },
  /AUTO_ACCEPT_JOB_CUTOVER_EPOCH must be a concrete bounded identifier/,
);

for (const loopFlag of [
  "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
] as const) {
  assertFailure(
    {
      ...dedicatedRoleConfig("poller-service"),
      [loopFlag]: "true",
    },
    new RegExp(`${loopFlag} requires SPX_ROLE=auto-accept-service, worker, or combined`),
  );
  assertSuccess({
    ...dedicatedRoleConfig("auto-accept-service"),
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    [loopFlag]: "true",
  });
  assertSuccess({
    SPX_ROLE: "combined",
    SPX_NODE_ID: "",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    [loopFlag]: "true",
  });
}

for (const pollerFlag of [
  "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
  "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
  "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
] as const) {
  const teamSelector = pollerFlag === "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED"
    ? { AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: "2" }
    : pollerFlag === "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED"
      ? { AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: "2" }
      : {};

  assertSuccess({
    ...dedicatedRoleConfig("poller-service"),
    [pollerFlag]: "true",
    ...teamSelector,
  });
  assertSuccess({
    SPX_ROLE: "combined",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    [pollerFlag]: "true",
    ...teamSelector,
  });
  assertFailure(
    {
      ...dedicatedRoleConfig("auto-accept-service"),
      [pollerFlag]: "true",
      ...teamSelector,
    },
    new RegExp(`${pollerFlag} requires SPX_ROLE=poller-service, worker, or combined`),
  );
}

assertFailure(
  {
    ...dedicatedRoleConfig("auto-accept-service"),
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  },
  /SPX_ROLE=auto-accept-service requires at least one auto-accept worker loop/,
);

assertFailure(
  {
    SPX_ROLE: "api",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    AUTO_ACCEPT_JOB_SHADOW_ENABLED: "true",
  },
  /AUTO_ACCEPT_JOB_SHADOW_ENABLED requires SPX_ROLE=poller-service, worker, or combined/,
);

for (const existingRoleConfig of [
  { SPX_ROLE: "api", AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false" },
  { SPX_ROLE: "worker" },
  {
    SPX_ROLE: "notifier",
    SPX_NODE_ID: "notifier-01",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  },
  { SPX_ROLE: "combined", AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false" },
  {
    SPX_ROLE: "notification-service",
    SPX_NODE_ID: "notification-01",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    LINE_SERVICE_URL: "http://line-service.test",
    LINE_SERVICE_SEND_SECRET: "line-send-secret",
  },
  {
    SPX_ROLE: "line-service",
    SPX_NODE_ID: "line-01",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    LINE_SERVICE_SEND_SECRET: "line-send-secret",
    LINE_SERVICE_ADMIN_SECRET: "line-admin-secret",
  },
  {
    SPX_ROLE: "ocr-service",
    SPX_NODE_ID: "ocr-01",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  },
] as const) {
  assertSuccess(existingRoleConfig);
}

assertFailure(
  {
    SPX_ROLE: "ocr-service",
    SPX_NODE_ID: "ocr-admin-key-missing",
    OCR_SERVICE_ADMIN_SECRET: "",
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  },
  /OCR_SERVICE_ADMIN_SECRET/,
);
assertFailure(
  {
    SPX_ROLE: "ocr-service",
    SPX_NODE_ID: "ocr-admin-key-reused",
    OCR_SERVICE_ADMIN_SECRET: baseConfig.NOTIFIER_SHARED_SECRET,
    AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
  },
  /OCR_SERVICE_ADMIN_SECRET must be distinct from NOTIFIER_SHARED_SECRET/,
);

for (const provider of ["auto", "codex-cli"] as const) {
  assertFailure(
    {
      SPX_ROLE: "ocr-service",
      SPX_NODE_ID: "ocr-production-01",
      NODE_ENV: "production",
      CODEX_IMAGE_PROVIDER: provider,
      ...productionOcrBoundary,
      AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
    },
    /production OCR requires CODEX_IMAGE_PROVIDER=codex-device/,
  );
}

assertSuccess({
  SPX_ROLE: "ocr-service",
  SPX_NODE_ID: "ocr-production-01",
  NODE_ENV: "production",
  CODEX_IMAGE_PROVIDER: "codex-device",
  ...productionOcrBoundary,
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
});

assertSuccess({
  SPX_ROLE: "ocr-service",
  SPX_NODE_ID: "ocr-db-free-01",
  NODE_ENV: "production",
  HTTP_ENABLED: "true",
  DB_MODE: "mysql",
  DB_HOST: "",
  DB_USERNAME: "",
  DB_PASSWORD: "",
  DB_NAME: "",
  CODEX_IMAGE_PROVIDER: "codex-device",
  ...productionOcrBoundary,
  AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED: "false",
});
