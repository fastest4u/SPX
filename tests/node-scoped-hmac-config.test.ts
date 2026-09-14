import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;
const envModuleUrl = pathToFileURL(resolve(process.cwd(), "src/config/env.ts")).href;
const keyA = "a".repeat(32);
const keyB = "b".repeat(32);
const gate6ControlKey = "g".repeat(32);

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

const baseConfig: Record<string, string> = {
  NODE_ENV: "production",
  SECRETS_KEY: "s".repeat(32),
  DB_MODE: "mysql",
  DB_HOST: "mysql.example.test",
  DB_PORT: "3306",
  DB_USERNAME: "spx-role",
  DB_PASSWORD: "db-password",
  DB_NAME: "spx_production",
  DB_SSL_MODE: "verify-identity",
  DB_SSL_CA_FILE: "/run/config/db-ca.pem",
  HTTP_ENABLED: "false",
  API_URL: "https://spx.example.test/booking/bidding/list",
  APP_NAME: "SPX",
  REFERER: "https://spx.example.test/",
};

function runValidation(overrides: Record<string, string | undefined>) {
  const tempDir = mkdtempSync(join(tmpdir(), "spx-node-hmac-config-"));
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
    try { mod.validateRuntimeConfig(); console.log("VALID"); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(42); }
  `;
  try {
    return spawnSync(process.execPath, ["--import", tsxRegisterUrl, "-e", script], {
      cwd: tempDir,
      encoding: "utf8",
      env: childEnv,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function assertSuccess(overrides: Record<string, string | undefined>): void {
  const result = runValidation(overrides);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VALID/);
}

function assertFailure(
  overrides: Record<string, string | undefined>,
  expected: RegExp,
): void {
  const result = runValidation(overrides);
  assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stderr, new RegExp(keyA));
  assert.doesNotMatch(result.stderr, new RegExp(keyB));
  assert.doesNotMatch(result.stderr, new RegExp(gate6ControlKey));
}

const worker = {
  SPX_ROLE: "worker",
  SPX_NODE_ID: "worker-ifn-01",
  RUN_TEAM_IDS: "2",
  NOTIFIER_API_URL: "http://notification-service:3002/internal/notification-events",
  NOTIFICATION_NODE_SECRET: keyA,
};
assertSuccess(worker);
assertFailure(
  { ...worker, NOTIFICATION_NODE_SECRET: "", NOTIFIER_SHARED_SECRET: keyA },
  /NOTIFICATION_NODE_SECRET/,
);
for (const invalidNodeEnv of ["Production", "production ", "prod"] as const) {
  assertFailure(
    {
      ...worker,
      NODE_ENV: invalidNodeEnv,
      NOTIFICATION_NODE_SECRET: "",
      NOTIFIER_SHARED_SECRET: keyA,
    },
    /NODE_ENV must be exactly development, test, or production/,
  );
}
assertFailure({ ...worker, NODE_ENV: undefined }, /NODE_ENV/);

const notificationService = {
  SPX_ROLE: "notification-service",
  SPX_NODE_ID: "notification-01",
  LINE_SERVICE_URL: "http://line-service:3003",
  LINE_SERVICE_SEND_SECRET: "l".repeat(32),
  NOTIFICATION_NODE_SECRETS: `worker-ifn-01=${keyA}`,
  NOTIFICATION_ALLOWED_NODE_TEAMS: "worker-ifn-01:2",
};
assertSuccess(notificationService);

const legacyNotifier = {
  SPX_ROLE: "notifier",
  SPX_NODE_ID: "notifier-01",
  LINE_SERVICE_URL: "http://line-service:3003",
  LINE_SERVICE_SEND_SECRET: "n".repeat(32),
  NOTIFICATION_NODE_SECRETS: `worker-ifn-01=${keyA}`,
  NOTIFICATION_ALLOWED_NODE_TEAMS: "worker-ifn-01:2",
};
assertSuccess(legacyNotifier);
assertFailure(
  { ...legacyNotifier, LINE_SERVICE_URL: "" },
  /LINE_SERVICE_URL/,
);

assertFailure(
  {
    ...notificationService,
    NOTIFICATION_ALLOWED_NODE_TEAMS: "worker-unknown-01:2",
  },
  /NOTIFICATION_NODE_SECRETS.*exactly match.*NOTIFICATION_ALLOWED_NODE_TEAMS/,
);
assertFailure(
  {
    ...notificationService,
    NOTIFICATION_NODE_SECRETS: `worker-ifn-01=${keyA},worker-ptwl-01=${keyA}`,
    NOTIFICATION_ALLOWED_NODE_TEAMS: "worker-ifn-01:2;worker-ptwl-01:1",
  },
  /duplicate secret/,
);

const ocrService = {
  NODE_ENV: "production",
  SECRETS_KEY: "",
  DB_MODE: "mysql",
  DB_HOST: "",
  DB_USERNAME: "",
  DB_PASSWORD: "",
  DB_NAME: "",
  SPX_ROLE: "ocr-service",
  SPX_NODE_ID: "ocr-01",
  HTTP_ENABLED: "true",
  CODEX_IMAGE_PROVIDER: "codex-device",
  OCR_NODE_SECRETS: `line-service-01=${keyA},web-api-01=${keyB}`,
  OCR_ALLOWED_LINE_NODE_IDS: "line-service-01",
  OCR_ADMIN_NODE_IDS: "web-api-01",
  OCR_REPLAY_LEDGER_DIR: "/app/data/internal-replay",
  GATE6_CONTROL_NODE_SECRET: gate6ControlKey,
  GATE6_OCR_PERMIT_KEY_ID: "gate6-ocr-permit-v1",
  GATE6_OCR_PERMIT_PUBLIC_KEY_FILE: "/run/secrets/gate6-ocr-permit-public-key.pem",
};
assertSuccess(ocrService);
assertFailure(
  { ...ocrService, OCR_NODE_SECRETS: "" },
  /OCR_NODE_SECRETS/,
);
assertFailure(
  { ...ocrService, OCR_REPLAY_LEDGER_DIR: "" },
  /OCR_REPLAY_LEDGER_DIR/,
);
for (const invalidLedgerDir of [
  "/tmp/internal-replay",
  "/app/data/../private/internal-replay",
  "/app/data",
] as const) {
  assertFailure(
    { ...ocrService, OCR_REPLAY_LEDGER_DIR: invalidLedgerDir },
    /OCR_REPLAY_LEDGER_DIR must be a canonical absolute path under \/app\/data\//,
  );
}

assertSuccess({
  SPX_ROLE: "migrator",
  SPX_NODE_ID: "",
  HTTP_ENABLED: "false",
  SECRETS_KEY: "",
});
assertFailure(
  { ...ocrService, OCR_ADMIN_NODE_IDS: "line-service-01" },
  /classified exactly once|overlap/,
);

const lineService = {
  SPX_ROLE: "line-service",
  SPX_NODE_ID: "line-service-01",
  LINE_SERVICE_SEND_SECRET: "",
  LINE_SERVICE_SEND_NODE_SECRETS: `notification-service-01=${keyA},web-api-01=${keyB}`,
  LINE_SERVICE_ADMIN_SECRET: "m".repeat(32),
  LINE_SEND_ALLOWED_NODE_IDS: "notification-service-01,web-api-01",
  LINE_ADMIN_ALLOWED_NODE_IDS: "web-api-01",
  OCR_SERVICE_URL: "http://ocr-service:3004",
  OCR_NODE_SECRET: keyA,
  GATE6_CONTROL_NODE_SECRET: gate6ControlKey,
  GATE6_LINE_PERMIT_KEY_ID: "gate6-line-permit-v1",
  GATE6_LINE_PERMIT_PUBLIC_KEY_FILE: "/run/secrets/gate6-line-permit-public-key.pem",
};
assertSuccess(lineService);
assertFailure(
  { ...lineService, OCR_NODE_SECRET: "", NOTIFIER_SHARED_SECRET: keyA },
  /OCR_NODE_SECRET/,
);
assertFailure(
  { ...lineService, LINE_SERVICE_SEND_NODE_SECRETS: "" },
  /LINE_SERVICE_SEND_NODE_SECRETS/,
);
assertFailure(
  { ...lineService, LINE_SEND_ALLOWED_NODE_IDS: "notification-service-01" },
  /LINE_SERVICE_SEND_NODE_SECRETS.*exactly match.*LINE_SEND_ALLOWED_NODE_IDS/,
);
assertFailure(
  { ...lineService, LINE_SERVICE_ADMIN_SECRET: keyA },
  /LINE_SERVICE_ADMIN_SECRET must be distinct from LINE_SERVICE_SEND_NODE_SECRETS/,
);

assertFailure(
  {
    SPX_ROLE: "combined",
    SPX_NODE_ID: "combined-production-01",
    NOTIFICATION_NODE_SECRET: keyA,
    NOTIFICATION_NODE_SECRETS: `combined-production-01=${keyA}`,
    NOTIFICATION_ALLOWED_NODE_TEAMS: "combined-production-01:2",
  },
  /SPX_ROLE=combined is not allowed in production/,
);

console.log("node-scoped-hmac-config: production fallback and allowlist guards verified");
