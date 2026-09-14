import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeRealtimeServiceUrl,
  parseRealtimeAdminNodeIds,
  parseRealtimeNodeSecrets,
  parseRealtimeTrustedNodeIds,
} from "../src/config/env.js";

const realtimeKeyA = "a".repeat(32);
const realtimeKeyB = "b".repeat(32);

assert.equal(normalizeRealtimeServiceUrl(undefined), "");
assert.equal(
  normalizeRealtimeServiceUrl(" https://realtime.internal.example:3004 "),
  "https://realtime.internal.example:3004/internal/realtime",
);
assert.equal(
  normalizeRealtimeServiceUrl("https://realtime.internal.example:3004/internal/realtime/"),
  "https://realtime.internal.example:3004/internal/realtime",
);
assert.throws(() => normalizeRealtimeServiceUrl("ftp://realtime.internal.example"), /http/);
assert.throws(() => normalizeRealtimeServiceUrl("https://realtime.internal.example/wrong"), /internal\/realtime/);
assert.throws(
  () => normalizeRealtimeServiceUrl("https://reader:password@realtime.internal.example"),
  /credentials/,
);
assert.throws(
  () => normalizeRealtimeServiceUrl("https://realtime.internal.example?token=secret"),
  /query|fragment/,
);
assert.throws(
  () => normalizeRealtimeServiceUrl("https://realtime.internal.example/#debug"),
  /query|fragment/,
);

assert.deepEqual([...parseRealtimeTrustedNodeIds(undefined)], []);
assert.deepEqual(
  [...parseRealtimeTrustedNodeIds(" web-01, worker-02, web-01 ")],
  ["web-01", "worker-02"],
);
assert.throws(() => parseRealtimeTrustedNodeIds("web-01,,worker-02"), /empty/);
assert.deepEqual(
  [...parseRealtimeAdminNodeIds(" web-01, notification-01, web-01 ")],
  ["web-01", "notification-01"],
);
assert.throws(() => parseRealtimeAdminNodeIds("web-01,,notification-01"), /empty/);
assert.deepEqual(
  [...parseRealtimeNodeSecrets(`web-01=${realtimeKeyA},worker-02=${realtimeKeyB}`)],
  [["web-01", { active: realtimeKeyA }], ["worker-02", { active: realtimeKeyB }]],
);
assert.throws(() => parseRealtimeNodeSecrets("web-01"), /node-id=secret/);
assert.throws(() => parseRealtimeNodeSecrets("web-01="), /node-id=secret/);
assert.throws(
  () => parseRealtimeNodeSecrets(`web-01=${realtimeKeyA},web-01=${realtimeKeyB}`),
  /duplicate node id/,
);
assert.throws(
  () => parseRealtimeNodeSecrets(`web-01=${realtimeKeyA},worker-02=${realtimeKeyA}`),
  /duplicate secret/,
);
try {
  parseRealtimeNodeSecrets(`web-01=${realtimeKeyA},worker-02=${realtimeKeyA}`);
  assert.fail("duplicate realtime node secrets must be rejected");
} catch (error) {
  assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(realtimeKeyA));
}

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;
const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/config/env.ts")).href;
const passthroughEnvKeys = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
  "TEMP", "TMP", "USERPROFILE", "HOME",
];

const baseConfig: Record<string, string> = {
  NODE_ENV: "test",
  SECRETS_KEY: "test-secrets-key-with-at-least-32-characters",
  DB_MODE: "memory",
  SPX_ROLE: "api",
  HTTP_ENABLED: "false",
};

function runValidation(overrides: Record<string, string | undefined>) {
  const tempDir = mkdtempSync(join(tmpdir(), "spx-realtime-runtime-config-"));
  const childEnv: Record<string, string> = { ...baseConfig };
  for (const key of passthroughEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const script = `
    const mod = await import(${JSON.stringify(envModuleUrl)});
    try { mod.validateRuntimeConfig(); console.log(JSON.stringify({
      url: mod.env.REALTIME_SERVICE_URL,
      trusted: [...mod.env.REALTIME_TRUSTED_NODE_IDS],
    })); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(42); }
  `;
  try {
    return spawnSync(process.execPath, ["--import", tsxRegisterUrl, "-e", script], {
      cwd: tempDir,
      encoding: "utf8",
      env: childEnv,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertSuccess(overrides: Record<string, string | undefined>) {
  const result = runValidation(overrides);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function assertFailure(overrides: Record<string, string | undefined>, pattern: RegExp) {
  const result = runValidation(overrides);
  assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, pattern);
  return result;
}

assertSuccess({ REALTIME_SERVICE_URL: "" });
const remote = assertSuccess({
  REALTIME_SERVICE_URL: "https://realtime.internal.example:3004",
  REALTIME_SHARED_SECRET: "remote-shared-secret",
  REALTIME_REQUEST_TIMEOUT_MS: "2500",
  REALTIME_TRUSTED_NODE_IDS: "",
  SPX_NODE_ID: "web-01",
});
assert.match(remote.stdout, /https:\/\/realtime\.internal\.example:3004\/internal\/realtime/);

for (const [overrides, pattern] of [
  [{ REALTIME_SERVICE_URL: "ftp://realtime.internal.example", SPX_NODE_ID: "web-01", REALTIME_SHARED_SECRET: "secret" }, /REALTIME_SERVICE_URL/],
  [{ REALTIME_SERVICE_URL: "https://realtime.internal.example/wrong", SPX_NODE_ID: "web-01", REALTIME_SHARED_SECRET: "secret" }, /internal\/realtime/],
  [{ REALTIME_SERVICE_URL: "https://realtime.internal.example", SPX_NODE_ID: "", REALTIME_SHARED_SECRET: "secret" }, /SPX_NODE_ID/],
  [{ REALTIME_SERVICE_URL: "https://realtime.internal.example", SPX_NODE_ID: "web-01", REALTIME_SHARED_SECRET: "" }, /REALTIME_SHARED_SECRET/],
  [{ REALTIME_SERVICE_URL: "https://realtime.internal.example", SPX_NODE_ID: "web-01", REALTIME_SHARED_SECRET: "secret", REALTIME_REQUEST_TIMEOUT_MS: "0" }, /REALTIME_REQUEST_TIMEOUT_MS/],
] as const) {
  assertFailure(overrides, pattern);
}

assertSuccess({
  SPX_ROLE: "api",
  REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA}`,
});
for (const forbiddenRoleConfig of [
  {
    SPX_ROLE: "worker",
    SPX_NODE_ID: "worker-01",
    RUN_TEAM_IDS: "1",
    NOTIFIER_API_URL: "http://notification-service:3002/internal/notification-events",
    NOTIFIER_SHARED_SECRET: "notifier-secret",
    API_URL: "https://spx.example.test/booking/bidding/list",
    APP_NAME: "SPX",
    REFERER: "https://spx.example.test/",
  },
  {
    SPX_ROLE: "poller-service",
    SPX_NODE_ID: "poller-01",
    RUN_TEAM_IDS: "1",
    NOTIFIER_API_URL: "http://notification-service:3002/internal/notification-events",
    NOTIFIER_SHARED_SECRET: "notifier-secret",
    API_URL: "https://spx.example.test/booking/bidding/list",
    APP_NAME: "SPX",
    REFERER: "https://spx.example.test/",
  },
  {
    SPX_ROLE: "auto-accept-service",
    SPX_NODE_ID: "auto-accept-01",
    RUN_TEAM_IDS: "1",
    NOTIFIER_API_URL: "http://notification-service:3002/internal/notification-events",
    NOTIFIER_SHARED_SECRET: "notifier-secret",
    AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED: "true",
    API_URL: "https://spx.example.test/booking/bidding/list",
    APP_NAME: "SPX",
    REFERER: "https://spx.example.test/",
  },
  {
    SPX_ROLE: "line-service",
    SPX_NODE_ID: "line-01",
    NOTIFIER_SHARED_SECRET: "notifier-secret",
    LINE_SERVICE_SEND_SECRET: "line-send-secret",
    LINE_SERVICE_ADMIN_SECRET: "line-admin-secret",
  },
  {
    SPX_ROLE: "ocr-service",
    SPX_NODE_ID: "ocr-01",
    NOTIFIER_SHARED_SECRET: "notifier-secret",
    OCR_SERVICE_ADMIN_SECRET: "ocr-admin-secret",
  },
] as const) {
  assertFailure(
    { ...forbiddenRoleConfig, REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA}` },
    /REALTIME_NODE_SECRETS.*not allowed.*SPX_ROLE/,
  );
}

const realtimeService = {
  SPX_ROLE: "realtime-service",
  SPX_NODE_ID: "realtime-01",
  HTTP_ENABLED: "true",
  REALTIME_SERVICE_URL: "",
  REALTIME_TRUSTED_NODE_IDS: "web-01,worker-02",
  REALTIME_ADMIN_NODE_IDS: "web-01",
  REALTIME_ALLOWED_NODE_TEAMS: "worker-02:2,3",
  REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA},worker-02=${realtimeKeyB}`,
};
assertSuccess(realtimeService);
assertFailure({ ...realtimeService, HTTP_ENABLED: "false" }, /HTTP_ENABLED=true/);
assertFailure({ ...realtimeService, SPX_NODE_ID: "" }, /SPX_NODE_ID/);
assertFailure({ ...realtimeService, REALTIME_TRUSTED_NODE_IDS: "" }, /REALTIME_TRUSTED_NODE_IDS/);
assertFailure({ ...realtimeService, REALTIME_NODE_SECRETS: "" }, /REALTIME_NODE_SECRETS/);
assertFailure(
  { ...realtimeService, REALTIME_SERVICE_URL: "https://realtime.internal.example" },
  /REALTIME_SERVICE_URL.*empty/,
);
assertFailure(
  { ...realtimeService, REALTIME_ALLOWED_NODE_TEAMS: "worker-03:3" },
  /REALTIME_ALLOWED_NODE_TEAMS.*trusted/,
);
assertFailure(
  { ...realtimeService, REALTIME_ADMIN_NODE_IDS: "web-03" },
  /REALTIME_ADMIN_NODE_IDS.*trusted/,
);
assertFailure(
  { ...realtimeService, REALTIME_ADMIN_NODE_IDS: "web-01,worker-02" },
  /classified exactly once|overlap/,
);
assertFailure(
  { ...realtimeService, REALTIME_ADMIN_NODE_IDS: "" },
  /classified exactly once|missing classification/,
);
assertFailure(
  {
    ...realtimeService,
    REALTIME_ADMIN_NODE_IDS: "",
    REALTIME_ALLOWED_NODE_TEAMS: "web-01:1;worker-02:2,3",
  },
  /REALTIME_ADMIN_NODE_IDS.*at least one/,
);
assertFailure(
  { ...realtimeService, REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA}` },
  /REALTIME_NODE_SECRETS.*exactly match/,
);
assertFailure(
  {
    ...realtimeService,
    REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA},worker-02=${realtimeKeyB},worker-03=${"c".repeat(32)}`,
  },
  /REALTIME_NODE_SECRETS.*exactly match/,
);
const duplicateSecretFailure = assertFailure(
  { ...realtimeService, REALTIME_NODE_SECRETS: `web-01=${realtimeKeyA},worker-02=${realtimeKeyA}` },
  /REALTIME_NODE_SECRETS.*duplicate secret/,
);
assert.doesNotMatch(duplicateSecretFailure.stderr, new RegExp(realtimeKeyA));
assertFailure(
  { ...realtimeService, NODE_ENV: "production", DB_MODE: "memory" },
  /DB_MODE=memory.*realtime-service/,
);
assertFailure(
  {
    ...realtimeService,
    NODE_ENV: "production",
    DB_MODE: "mysql",
    DB_HOST: "",
    DB_USERNAME: "",
    DB_PASSWORD: "",
    DB_NAME: "",
  },
  /DB_HOST/,
);
assertSuccess({
  ...realtimeService,
  NODE_ENV: "production",
  DB_MODE: "mysql",
  DB_HOST: "mysql.internal",
  DB_PORT: "3306",
  DB_USERNAME: "spx",
  DB_PASSWORD: "db-secret",
  DB_NAME: "spx",
  DB_SSL_MODE: "verify-identity",
  DB_SSL_CA_FILE: "/run/config/db-ca.pem",
});
