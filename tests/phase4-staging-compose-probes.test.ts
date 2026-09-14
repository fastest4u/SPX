import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const overlay = readFileSync("docker-compose.staging.yml", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const envReference = readFileSync("docs/env-reference.md", "utf8");

function serviceBlock(name: string): string {
  const servicesStart = overlay.indexOf("\nservices:\n");
  const networksStart = overlay.indexOf("\nnetworks:\n", servicesStart);
  assert.notEqual(servicesStart, -1);
  assert.notEqual(networksStart, -1);
  const services = overlay.slice(servicesStart, networksStart);
  const match = services.match(
    new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9][a-z0-9-]+:\\r?$|(?![\\s\\S]))`, "m"),
  );
  assert.ok(match, `${name} is missing from the staging overlay`);
  return match[0];
}

const common = overlay.match(/^x-n-minus-one-common:[\s\S]*?(?=^x-|^services:)/m)?.[0] ?? "";
const commonEnvironment =
  overlay.match(/^x-n-minus-one-environment:[\s\S]*?(?=^x-|^services:)/m)?.[0] ?? "";
assert.match(common, /image:\s*\$\{SPX_N_MINUS_ONE_IMAGE:\?SPX_N_MINUS_ONE_IMAGE is required\}/);
assert.match(common, /profiles:\s*\["n-minus-one"\]/);
assert.match(common, /command:\s*\["node",\s*"dist\/scripts\/phase4-n-minus-one-role-probe\.js"\]/);
assert.match(common, /com\.spx\.n-minus-one:\s*"true"/);
assert.match(common, /read_only:\s*true/);
assert.match(common, /cap_drop:\s*\r?\n\s*- ALL/);
assert.match(common, /no-new-privileges:true/);
assert.match(common, /restart:\s*"no"/);
assert.doesNotMatch(common, /ports:|depends_on:|docker\.sock/i);

for (const key of [
  "SPX_PROBE_ONLY",
  "SPX_ENVIRONMENT",
  "HTTP_ENABLED",
  "NOTIFY_ENABLED",
  "LINEJS_TEST_ENABLED",
  "AUTO_ACCEPT_ENABLED",
  "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
  "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
  "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
]) {
  assert.match(commonEnvironment, new RegExp(`^  ${key}:`, "m"), `${key} must be fixed`);
}
assert.match(commonEnvironment, /^ {2}SPX_PROBE_ONLY:\s*"true"$/m);
assert.match(commonEnvironment, /^ {2}SPX_ENVIRONMENT:\s*staging$/m);
for (const key of [
  "HTTP_ENABLED",
  "NOTIFY_ENABLED",
  "LINEJS_TEST_ENABLED",
  "AUTO_ACCEPT_ENABLED",
  "AUTO_ACCEPT_JOB_SHADOW_ENABLED",
  "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED",
  "AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED",
  "AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED",
]) {
  assert.match(commonEnvironment, new RegExp(`^  ${key}:\\s*"false"$`, "m"));
}
assert.doesNotMatch(
  `${common}\n${commonEnvironment}`,
  /(?:NOTIFIER_API_URL|LINE_SERVICE_URL|OCR_SERVICE_URL|REALTIME_SERVICE_URL|LINE_USER_ID|CODEX_IMAGE_PROVIDER|SECRET|TOKEN|PRIVATE_KEY)/,
);

const dbRoles = {
  "n-minus-one-web-probe": {
    role: "api",
    node: "stg-n-minus-one-web-api",
    team: "",
    username: "SPX_DB_USERNAME_WEB_API",
    secret: "db_password_web_api",
  },
  "n-minus-one-notification-probe": {
    role: "notification-service",
    node: "stg-n-minus-one-notification-service",
    team: "",
    username: "SPX_DB_USERNAME_NOTIFICATION_SERVICE",
    secret: "db_password_notification_service",
  },
  "n-minus-one-line-probe": {
    role: "line-service",
    node: "stg-n-minus-one-line-service",
    team: "",
    username: "SPX_DB_USERNAME_LINE_SERVICE",
    secret: "db_password_line_service",
  },
  "n-minus-one-worker-ifn-probe": {
    role: "worker",
    node: "stg-n-minus-one-worker-ifn-split",
    team: "2",
    username: "SPX_DB_USERNAME_WORKER_IFN_SPLIT",
    secret: "db_password_worker_ifn_split",
  },
  "n-minus-one-worker-ptwl-probe": {
    role: "worker",
    node: "stg-n-minus-one-worker-ptwl-split",
    team: "1",
    username: "SPX_DB_USERNAME_WORKER_PTWL_SPLIT",
    secret: "db_password_worker_ptwl_split",
  },
} as const;

for (const [service, expected] of Object.entries(dbRoles)) {
  const block = serviceBlock(service);
  assert.match(block, /<<:\s*\*n-minus-one-common/);
  assert.match(block, /<<:\s*\*n-minus-one-environment/);
  assert.match(block, new RegExp(`SPX_ROLE:\\s*${expected.role}`));
  assert.match(block, new RegExp(`SPX_NODE_ID:\\s*${expected.node}`));
  assert.match(block, new RegExp(`RUN_TEAM_IDS:\\s*"${expected.team}"`));
  assert.match(block, /DB_MODE:\s*mysql/);
  assert.match(block, /DB_HOST:\s*n-minus-one-db-proxy/);
  assert.match(block, /DB_NAME:\s*spx_staging/);
  assert.match(block, /DB_PASSWORD_FILE:\s*\/run\/secrets\/db_password/);
  assert.match(block, /DB_SSL_MODE:\s*verify-identity/);
  assert.match(block, /DB_SSL_CA_FILE:\s*\/run\/config\/db-ca\.pem/);
  assert.match(block, /DB_SSL_SERVERNAME:\s*\$\{SPX_DB_SSL_SERVERNAME:/);
  assert.match(block, new RegExp(`DB_USERNAME:\\s*\\$\\{${expected.username}:`));
  assert.match(block, new RegExp(`source:\\s*${expected.secret}`));
  assert.match(block, /target:\s*db_password/);
  assert.match(block, /target:\s*\/run\/config\/db-ca\.pem/);
  assert.match(block, /networks:\s*\r?\n\s+n-minus-one-internal:/);
  assert.doesNotMatch(
    block,
    /\bports:|staging-db-proxy|gate6-db-proxy|NOTIFIER_API_URL|LINE_SERVICE_URL|OCR_SERVICE_URL|REALTIME_SERVICE_URL|GATE6_|JWT_|COOKIE_|ADMIN_PASSWORD|SECRETS_KEY/i,
  );
}

const ocr = serviceBlock("n-minus-one-ocr-probe");
assert.match(ocr, /<<:\s*\*n-minus-one-common/);
assert.match(ocr, /SPX_ROLE:\s*ocr-service/);
assert.match(ocr, /SPX_NODE_ID:\s*stg-n-minus-one-ocr-service/);
assert.match(ocr, /RUN_TEAM_IDS:\s*""/);
assert.match(ocr, /network_mode:\s*none/);
assert.doesNotMatch(ocr, /\bDB_|secrets:|volumes:|ports:/);

const nMinusOneProxy = serviceBlock("n-minus-one-db-proxy");
assert.match(nMinusOneProxy, /profiles:\s*\["n-minus-one"\]/);
assert.match(
  nMinusOneProxy,
  /command:\s*\["node",\s*"scripts\/staging-db-proxy\.mjs"\]/,
);
assert.match(nMinusOneProxy, /com\.spx\.n-minus-one:\s*"true"/);
assert.match(nMinusOneProxy, /STAGING_DB_UPSTREAM_HOST:\s*\$\{SPX_DB_HOST:/);
assert.match(
  nMinusOneProxy,
  /networks:\s*[\s\S]*?n-minus-one-internal:[\s\S]*?n-minus-one-db-egress:/,
);
assert.doesNotMatch(nMinusOneProxy, /\bports:|secrets:|DB_PASSWORD|docker\.sock/i);

const proxy = serviceBlock("staging-db-proxy");
assert.match(proxy, /profiles:\s*\["phase4"\]/);
assert.match(proxy, /command:\s*\["node",\s*"scripts\/staging-db-proxy\.mjs"\]/);
assert.match(proxy, /STAGING_DB_UPSTREAM_HOST:\s*\$\{STAGING_DB_UPSTREAM_HOST:/);
assert.match(proxy, /expose:\s*\["3306"\]/);
assert.match(proxy, /read_only:\s*true/);
assert.doesNotMatch(proxy, /\bports:|secrets:|DB_PASSWORD|docker\.sock/i);

const realtime = serviceBlock("realtime-service");
assert.match(realtime, /DB_HOST:\s*staging-db-proxy/);
assert.match(
  realtime,
  /DB_SSL_SERVERNAME:\s*\$\{STAGING_DB_UPSTREAM_TLS_SERVERNAME:/,
);

assert.match(overlay, /^ {2}n-minus-one-internal:\s*\r?\n\s+internal:\s*true$/m);
assert.match(overlay, /^ {2}n-minus-one-db-egress:\s*$/m);
assert.doesNotMatch(overlay, /spx-production|\/opt\/spx-production|prod-/i);

for (const variable of [
  "SPX_N_MINUS_ONE_IMAGE",
  "SPX_N_MINUS_ONE_RELEASE_SHA",
  "STAGING_DB_UPSTREAM_HOST",
  "STAGING_DB_UPSTREAM_PORT",
  "STAGING_DB_UPSTREAM_TLS_SERVERNAME",
  "STAGING_DB_PROXY_MAX_CONNECTIONS",
]) {
  assert.match(envExample, new RegExp(`^${variable}=`, "m"), `${variable} example is missing`);
  assert.match(envReference, new RegExp(`\\| \\x60${variable}\\x60`), `${variable} docs are missing`);
}

console.log("Phase 4 staging proxy and N-1 Compose probes verified");
