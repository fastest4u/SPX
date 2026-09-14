import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const compose = readFileSync(resolve(root, "docker-compose.a3.yml"), "utf8");
const deployment = readFileSync(resolve(root, "docs/deployment-a3.md"), "utf8");
const envReference = readFileSync(resolve(root, "docs/env-reference.md"), "utf8");

function serviceBlock(serviceName: string): string {
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^  ${escaped}:\\s*$`, "m").exec(compose);
  assert.ok(header, `compose service ${serviceName} must exist`);
  const afterHeader = header.index + header[0].length;
  const remainder = compose.slice(afterHeader);
  const nextService = /^ {2}[a-zA-Z0-9][a-zA-Z0-9_-]*:\s*$/m.exec(remainder);
  return compose.slice(header.index, nextService ? afterHeader + nextService.index : compose.length);
}

function environmentValue(block: string, key: string): string {
  const match = block.match(new RegExp(`^      ${key}:\\s*(.+)$`, "m"));
  assert.ok(match, `${key} must exist in service environment`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function secretSourceForTarget(block: string, target: string): string {
  const match = block.match(
    new RegExp(`^      - source: ([a-z0-9_-]+)\\r?\\n        target: ${target}$`, "m"),
  );
  assert.ok(match, `secret target ${target} must exist`);
  return match[1];
}

function volumeSourceForTarget(block: string, target: string): string {
  const match = block.match(
    new RegExp(
      `^      - type: volume\\r?\\n        source: ([a-z0-9-]+)\\r?\\n        target: ${target}$`,
      "m",
    ),
  );
  assert.ok(match, `volume target ${target} must exist`);
  return match[1];
}

const phase3Services = [
  {
    name: "poller-ifn-phase3",
    role: "poller-service",
    teamId: "2",
    urlVariable: "SPX_REALTIME_POLLER_IFN_PHASE3_URL",
  },
  {
    name: "auto-accept-ifn-phase3",
    role: "auto-accept-service",
    teamId: "2",
    urlVariable: "SPX_REALTIME_AUTO_ACCEPT_IFN_PHASE3_URL",
  },
  {
    name: "poller-ptwl-phase3",
    role: "poller-service",
    teamId: "1",
    urlVariable: "SPX_REALTIME_POLLER_PTWL_PHASE3_URL",
  },
  {
    name: "auto-accept-ptwl-phase3",
    role: "auto-accept-service",
    teamId: "1",
    urlVariable: "SPX_REALTIME_AUTO_ACCEPT_PTWL_PHASE3_URL",
  },
] as const;

const phase3NodeIds = new Set<string>();
const phase3SpoolVolumes = new Set<string>();
const phase3SecretSources = new Set<string>();
for (const service of phase3Services) {
  const block = serviceBlock(service.name);
  assert.match(block, /^ {4}<<: \*spx-common$/m, `${service.name} must share the hardened runtime`);
  assert.match(block, /^ {4}profiles: \["phase3"\]$/m, `${service.name} must stay default-off`);
  assert.match(block, /^ {6}<<: \*spx-db-environment$/m);
  assert.equal(environmentValue(block, "SPX_ROLE"), service.role);
  assert.equal(environmentValue(block, "RUN_TEAM_IDS"), service.teamId);
  assert.equal(environmentValue(block, "HTTP_ENABLED"), "false");
  assert.match(
    block,
    service.role === "poller-service"
      ? /^ {4}healthcheck: \*spx-worker-healthcheck$/m
      : /^ {4}healthcheck: \*spx-process-healthcheck$/m,
  );
  assert.doesNotMatch(block, /^ {4}(?:ports|expose):/m, `${service.name} must remain headless`);
  assert.equal(environmentValue(block, "REALTIME_SERVICE_URL"), `\${${service.urlVariable}:-}`);
  assert.equal(environmentValue(block, "REALTIME_SHARED_SECRET_FILE"), "/run/secrets/realtime_shared_secret");
  assert.doesNotMatch(block, /^ {6}REALTIME_SHARED_SECRET:/m);
  assert.doesNotMatch(block, /^ {6}REALTIME_NODE_SECRETS(?:_FILE)?:/m);
  assert.match(block, /^ {6}REALTIME_REQUEST_TIMEOUT_MS: "\$\{SPX_REALTIME_REQUEST_TIMEOUT_MS:-1500\}"$/m);
  phase3NodeIds.add(environmentValue(block, "SPX_NODE_ID"));
  phase3SpoolVolumes.add(volumeSourceForTarget(block, "/app/spool"));
  phase3SecretSources.add(secretSourceForTarget(block, "realtime_shared_secret"));
}
assert.equal(phase3NodeIds.size, phase3Services.length, "Phase 3 node IDs must be unique");
assert.equal(phase3SpoolVolumes.size, phase3Services.length, "Phase 3 spool volumes must be distinct");
assert.equal(phase3SecretSources.size, phase3Services.length, "Phase 3 node key files must be distinct");

for (const name of ["poller-ifn-phase3", "poller-ptwl-phase3"]) {
  const block = serviceBlock(name);
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED"), "false");
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED"), "false");
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED"), "false");
}
for (const name of ["auto-accept-ifn-phase3", "auto-accept-ptwl-phase3"]) {
  const block = serviceBlock(name);
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED"), "false");
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED"), "true");
  assert.equal(environmentValue(block, "AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED"), "true");
}

for (const legacyDefault of ["notifier", "worker-ifn", "worker-ptwl"]) {
  assert.doesNotMatch(serviceBlock(legacyDefault), /^ {4}profiles:/m, `${legacyDefault} must remain a default service`);
}
assert.doesNotMatch(compose, /^ {2}mysql:\s*$/m, "compose confidence topology must use the external shared MySQL");

const realtime = serviceBlock("realtime-service");
assert.match(realtime, /^ {4}profiles: \["realtime"\]$/m, "realtime-service must be default-off");
assert.equal(environmentValue(realtime, "SPX_ROLE"), "realtime-service");
assert.equal(environmentValue(realtime, "SPX_NODE_ID"), "prod-realtime-service-1");
assert.equal(environmentValue(realtime, "HTTP_ENABLED"), "true");
assert.equal(environmentValue(realtime, "HTTP_PORT"), "3005");
assert.equal(environmentValue(realtime, "REALTIME_SERVICE_URL"), "");
assert.equal(environmentValue(realtime, "REALTIME_NODE_SECRETS_FILE"), "/run/secrets/realtime_node_secrets");
assert.doesNotMatch(realtime, /^ {6}REALTIME_SHARED_SECRET(?:_FILE)?:/m);
assert.match(realtime, /^ {6}<<: \*spx-db-environment$/m);
assert.match(realtime, /^ {4}expose:\r?\n {6}- "3005"$/m);
assert.doesNotMatch(realtime, /^ {4}ports:/m, "realtime-service must not publish a host port");
assert.doesNotMatch(realtime, /^ {4}depends_on:/m, "realtime-service must not couple readiness to web/workers");
assert.match(realtime, /^ {6}REALTIME_TRUSTED_NODE_IDS: \$\{SPX_REALTIME_TRUSTED_NODE_IDS:\?/m);
assert.match(realtime, /^ {6}REALTIME_ADMIN_NODE_IDS: \$\{SPX_REALTIME_ADMIN_NODE_IDS:\?/m);
assert.match(realtime, /^ {6}REALTIME_ALLOWED_NODE_TEAMS: \$\{SPX_REALTIME_ALLOWED_NODE_TEAMS:\?/m);
assert.match(realtime, /^ {4}healthcheck: \*spx-http-healthcheck$/m);
assert.match(realtime, /^ {4}deploy:\r?\n {6}replicas: 1$/m, "compose must declare one realtime replica");

const realtimeClients = [
  { name: "notifier", urlVariable: "SPX_REALTIME_NOTIFIER_URL", hasIntakeSecrets: true },
  { name: "web-api", urlVariable: "SPX_REALTIME_WEB_API_URL", hasIntakeSecrets: true },
  { name: "notification-service", urlVariable: "SPX_REALTIME_NOTIFICATION_SERVICE_URL", hasIntakeSecrets: true },
  { name: "worker-ifn-split", urlVariable: "SPX_REALTIME_WORKER_IFN_SPLIT_URL", hasIntakeSecrets: false },
  { name: "worker-ptwl-split", urlVariable: "SPX_REALTIME_WORKER_PTWL_SPLIT_URL", hasIntakeSecrets: false },
  { name: "worker-ifn", urlVariable: "SPX_REALTIME_WORKER_IFN_URL", hasIntakeSecrets: false },
  { name: "worker-ptwl", urlVariable: "SPX_REALTIME_WORKER_PTWL_URL", hasIntakeSecrets: false },
] as const;
const clientUrlExpressions = new Set<string>();
const clientSecretSources = new Set<string>();
for (const client of realtimeClients) {
  const block = serviceBlock(client.name);
  const urlExpression = environmentValue(block, "REALTIME_SERVICE_URL");
  assert.equal(urlExpression, `\${${client.urlVariable}:-}`, client.name);
  assert.notEqual(urlExpression, "${REALTIME_SERVICE_URL:-}", "global realtime URL input is forbidden");
  clientUrlExpressions.add(urlExpression);
  assert.equal(environmentValue(block, "REALTIME_SHARED_SECRET_FILE"), "/run/secrets/realtime_shared_secret");
  assert.doesNotMatch(block, /^ {6}REALTIME_SHARED_SECRET:/m);
  clientSecretSources.add(secretSourceForTarget(block, "realtime_shared_secret"));
  if (client.hasIntakeSecrets) {
    assert.equal(environmentValue(block, "REALTIME_NODE_SECRETS_FILE"), "/run/secrets/realtime_node_secrets");
  } else {
    assert.doesNotMatch(block, /^ {6}REALTIME_NODE_SECRETS(?:_FILE)?:/m);
  }
  assert.doesNotMatch(block, /^ {8}realtime-service:\s*$/m, `${client.name} must not health-couple to realtime`);
}
assert.equal(clientUrlExpressions.size, realtimeClients.length, "each client must have an independent Compose URL input");
assert.equal(
  clientSecretSources.size,
  realtimeClients.length,
  "each producer must receive a distinct outbound node key file",
);
assert.equal(
  new Set([...phase3SecretSources, ...clientSecretSources]).size,
  phase3Services.length + realtimeClients.length,
  "outbound node keys must remain distinct across legacy, split, and Phase 3 clients",
);
for (const service of ["line-service", "ocr-service"]) {
  const block = serviceBlock(service);
  assert.doesNotMatch(block, /^ {6}REALTIME_SERVICE_URL:/m);
  assert.doesNotMatch(block, /^ {6}REALTIME_SHARED_SECRET(?:_FILE)?:/m);
  assert.doesNotMatch(block, /^ {6}REALTIME_NODE_SECRETS(?:_FILE)?:/m);
}

assert.match(deployment, /Phase 3 Poller\/Auto-Accept Compose Profile/i);
assert.match(deployment, /default-off/i);
assert.match(deployment, /start the auto-accept consumer[\s\S]*stop the legacy worker[\s\S]*lease[^\n]*release[\s\S]*zero live claims[\s\S]*start the poller-service/i);
assert.match(deployment, /queue is empty[\s\S]*explicitly quarantined/i);
assert.match(deployment, /staging|supervised production/i);
assert.match(deployment, /does not (?:prove|claim)[^\n]*live rollout/i);
assert.match(deployment, /MySQL advisory lock/i);
assert.match(deployment, /exactly one realtime-service replica/i);
assert.match(deployment, /`SPX_REALTIME_WEB_API_URL`[^\n]*empty[\s\S]*producer[^\n]*URL[^\n]*`http:\/\/web-api:3000`[\s\S]*restart[^\n]*(?:web|producer)[\s\S]*stop `realtime-service`/i);
assert.doesNotMatch(deployment, /each producer[^\n]*local persistent handlers/i);
assert.match(deployment, /does not load `\.env`[\s\S]*secret-file paths/i);
assert.match(deployment, /SPX_REALTIME_NODE_SECRETS_WEB_API_FILE/);
assert.match(deployment, /SPX_REALTIME_NODE_SECRETS_REALTIME_SERVICE_FILE/);
assert.match(deployment, /configured map is authoritative[\s\S]*unmapped caller never falls back/i);
assert.match(
  deployment,
  /Legacy shared authentication[\s\S]*non-production[\s\S]*rejects every unmapped/i,
  "production mapped trust must fail closed",
);

for (const key of [
  "REALTIME_SERVICE_URL",
  "REALTIME_SHARED_SECRET",
  "REALTIME_REQUEST_TIMEOUT_MS",
  "REALTIME_TRUSTED_NODE_IDS",
  "REALTIME_ADMIN_NODE_IDS",
  "REALTIME_NODE_SECRETS",
] as const) {
  assert.match(envReference, new RegExp(`\\| \\x60${key}\\x60`), `${key} must be documented`);
}
assert.match(envReference, /\/internal\/realtime/);
assert.match(envReference, /credentials[\s\S]*query[\s\S]*fragment/i);
assert.match(envReference, /node-id=secret/);
assert.match(envReference, /exactly one[\s\S]*(?:admin|team)/i);
assert.match(envReference, /poller-service[\s\S]*auto-accept-service[\s\S]*realtime-service/i);
assert.match(envReference, /map is configured[\s\S]*authoritative[\s\S]*unmapped[\s\S]*rejected/i);

console.log("phase3-phase4-compose-topology: all assertions passed");
