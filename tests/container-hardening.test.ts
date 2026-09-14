import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dockerfile = readFileSync(resolve(root, "Dockerfile.a3"), "utf8");
const compose = readFileSync(resolve(root, "docker-compose.a3.yml"), "utf8");
const policyPath = resolve(root, "deploy/runtime-isolation-policy.json");

const productionServices = [
  "migrator",
  "notifier",
  "web-api",
  "notification-service",
  "line-service",
  "ocr-service",
  "worker-ifn-split",
  "worker-ptwl-split",
  "worker-ifn",
  "worker-ptwl",
  "poller-ifn-phase3",
  "auto-accept-ifn-phase3",
  "poller-ptwl-phase3",
  "auto-accept-ptwl-phase3",
  "realtime-service",
  "gate6-control",
  "gate6-task9-controller",
  "gate6-db-proxy",
  "gate6-monitor-probe",
] as const;

function serviceSource(name: string): string {
  const servicesStart = compose.indexOf("\nservices:\n");
  const configsStart = compose.indexOf("\nconfigs:\n", servicesStart);
  assert.notEqual(servicesStart, -1, "Compose services section missing");
  assert.notEqual(configsStart, -1, "Compose configs section missing");
  const section = compose.slice(servicesStart, configsStart);
  const match = section.match(
    new RegExp(
      `^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9][a-z0-9-]+:\\r?$|(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `${name} missing from Compose`);
  return match[0];
}

interface ComposeVolumeBinding {
  type: "bind" | "volume";
  source: string;
  target: string;
  readOnly: boolean;
}

function volumeBindings(name: string): ComposeVolumeBinding[] {
  const source = serviceSource(name);
  return [...source.matchAll(
    /^ {6}- type: (bind|volume)\r?\n {8}source: ([^\r\n]+)\r?\n {8}target: ([^\r\n]+)(?:\r?\n {8}read_only: (true|false))?/gm,
  )].map((match) => ({
    type: match[1] as ComposeVolumeBinding["type"],
    source: match[2]!.trim(),
    target: match[3]!.trim(),
    readOnly: match[4] === "true",
  }));
}

function secretBindings(name: string): Array<{ source: string; target: string }> {
  return [...serviceSource(name).matchAll(
    /^ {6}- source: ([a-z0-9_-]+)\r?\n {8}target: ([a-z0-9_-]+)\r?$/gm,
  )].map((match) => ({ source: match[1]!, target: match[2]! }));
}

const mountTargets: Record<string, string> = {
  "public-ca": "/run/config/db-ca.pem",
  "line-state": "/app/data/line-state",
  "line-images": "/app/data/line-images",
  "ocr-auth": "/app/data",
  "notification-spool": "/app/spool",
  "gate6-production-keyring": "/run/config/gate6-production-keyring.json",
  "gate6-task9-request-config": "/run/config/gate6-task9-requests.json",
  "gate6-artifacts": "/run/gate6/artifacts",
  "gate6-actions": "/run/gate6/actions",
  "gate6-permits": "/run/gate6/permits",
};

const fixedBindSources: Record<string, string> = {
  "gate6-production-keyring":
    "${SPX_GATE6_PRODUCTION_KEYRING_PATH:?SPX_GATE6_PRODUCTION_KEYRING_PATH is required}",
  "gate6-task9-request-config":
    "${SPX_GATE6_TASK9_REQUEST_CONFIG_PATH:?SPX_GATE6_TASK9_REQUEST_CONFIG_PATH is required}",
  "gate6-artifacts": "/var/lib/spx-gate6/artifacts",
  "gate6-actions": "/var/lib/spx-gate6/actions",
  "gate6-permits": "/var/lib/spx-gate6/permits",
};

assert.match(
  dockerfile,
  /FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime/,
);
assert.match(dockerfile, /^ARG SPX_SOURCE_SHA$/m);
assert.match(dockerfile, /RUN test -n "\$SPX_SOURCE_SHA"/);
assert.match(dockerfile, /^LABEL org\.opencontainers\.image\.revision=\$SPX_SOURCE_SHA$/m);
assert.match(dockerfile, /^USER node$/m);
assert.match(
  dockerfile,
  /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/,
  "runtime image must remove the build-only global npm distribution",
);
assert.match(
  dockerfile,
  /install -d -o node -g node[^\n]*\/app\/data\/line-state[^\n]*\/app\/data\/line-images/,
  "fresh LINE named volumes need node-owned image mountpoints",
);
assert.match(dockerfile, /deploy\/runtime-isolation-policy\.json/);
assert.match(dockerfile, /scripts\/container-isolation-probe\.mjs/);
assert.match(dockerfile, /scripts\/gate6-production-monitor-probe\.mjs/);
assert.match(dockerfile, /scripts\/production-task9-controller\.mjs/);
assert.match(dockerfile, /scripts\/lib\/gate6-controller\.mjs/);
assert.match(dockerfile, /scripts\/lib\/gate6-cli-runtime\.mjs/);
assert.match(dockerfile, /scripts\/lib\/gate6-mysql-ledger\.mjs/);
assert.match(dockerfile, /scripts\/lib\/evidence-artifact\.mjs/);
assert.match(dockerfile, /src\/services\/gate6-approval-runtime\.mjs/);

assert.doesNotMatch(compose, /\benv_file:/);
assert.doesNotMatch(compose, /\.\/\.env:\/app\/\.env/);
assert.doesNotMatch(compose, /\.\/data:\/app\/data/);

const common = compose.match(/^x-spx-common:[\s\S]*?(?=^x-|^services:)/m)?.[0] ?? "";
for (const pattern of [
  /read_only:\s*true/,
  /cap_drop:\s*\r?\n\s*- ALL/,
  /no-new-privileges:true/,
  /pids_limit:/,
  /mem_limit:/,
  /cpus:/,
  /tmpfs:/,
]) {
  assert.match(common, pattern, `common container hardening missing ${pattern}`);
}
assert.match(
  common,
  /configs:\s*\r?\n\s*- source: spx_release_manifest\s*\r?\n\s*target: \/run\/secrets\/spx-release-manifest\s*\r?\n\s*mode: 0444/,
  "the signed release manifest config binding must be immutable and exact",
);

for (const service of productionServices) {
  assert.match(serviceSource(service), /<<:\s*\*spx-common/, `${service} must inherit hardening`);
  assert.doesNotMatch(
    serviceSource(service),
    /^\s{6}(?:[A-Z][A-Z0-9_]*(?:SECRET|SECRETS|PASSWORD|TOKEN|COOKIE)):\s/m,
    `${service} must not receive a plain secret environment variable`,
  );
}

const ocr = serviceSource("ocr-service");
for (const forbidden of ["DB_HOST", "DB_USERNAME", "DB_PASSWORD", "JWT_SECRET", "COOKIE_SECRET", "LINE_SERVICE_ADMIN_SECRET"]) {
  assert.doesNotMatch(ocr, new RegExp(`\\b${forbidden}(?:_FILE)?\\b`), `ocr-service must not receive ${forbidden}`);
}

const gate6Control = serviceSource("gate6-control");
assert.match(gate6Control, /profiles:\s*\["gate6"\]/);
assert.doesNotMatch(gate6Control, /^ {4}ports:/m, "gate6-control must not publish a host port");
assert.doesNotMatch(gate6Control, /docker\.sock|PRIVATE_KEY|SIGNING_KEY|MINT_SECRET/i);
for (const forbidden of [
  "API_URL",
  "COOKIE",
  "DEVICE_ID",
  "LINE_SERVICE_ADMIN_SECRET",
  "LINE_SERVICE_SEND_SECRET",
  "OCR_NODE_SECRET",
  "NOTIFIER_SHARED_SECRET",
  "SECRETS_KEY",
]) {
  assert.doesNotMatch(
    gate6Control,
    new RegExp(`\\b${forbidden}(?:_FILE)?\\b`),
    `gate6-control must not receive ${forbidden}`,
  );
}
assert.match(gate6Control, /networks:\s*\r?\n\s+gate6-control-internal:/);
assert.doesNotMatch(gate6Control, /networks:[\s\S]*?\r?\n\s+default:/);
const gate6DbProxy = serviceSource("gate6-db-proxy");
assert.doesNotMatch(gate6DbProxy, /^ {4}ports:/m);
assert.doesNotMatch(gate6DbProxy, /^ {4}secrets:/m);
assert.match(gate6DbProxy, /STAGING_DB_UPSTREAM_HOST:\s*\$\{SPX_DB_HOST/);
assert.match(gate6DbProxy, /networks:[\s\S]*?gate6-control-internal:[\s\S]*?gate6-db-egress:/);
assert.doesNotMatch(gate6DbProxy, /networks:[\s\S]*?\r?\n\s+default:/);

const gate6Monitor = serviceSource("gate6-monitor-probe");
assert.match(gate6Monitor, /profiles:\s*\["gate6"\]/);
assert.match(gate6Monitor, /DB_HOST:\s*gate6-db-proxy/);
assert.match(gate6Monitor, /DB_USERNAME:\s*\$\{SPX_DB_USERNAME_GATE6_MONITOR:\?/);
assert.match(gate6Monitor, /DB_PASSWORD_FILE:\s*\/run\/secrets\/db_password/);
assert.match(gate6Monitor, /command:\s*\["node",\s*"scripts\/gate6-production-monitor-probe\.mjs"\]/);
assert.doesNotMatch(gate6Monitor, /docker\.sock|LINE_TOKEN|CODEX|PRIVATE_KEY|SIGNING_KEY|MINT_SECRET/i);
assert.match(gate6Monitor, /networks:[\s\S]*?default:[\s\S]*?gate6-control-internal:/);
assert.doesNotMatch(gate6Monitor, /networks:[\s\S]*?gate6-db-egress:/);

const gate6Task9 = serviceSource("gate6-task9-controller");
assert.match(gate6Task9, /profiles:\s*\["gate6"\]/);
assert.match(gate6Task9, /restart:\s*"no"/);
assert.match(gate6Task9, /DB_HOST:\s*gate6-db-proxy/);
assert.match(gate6Task9, /DB_NAME:\s*spx/);
assert.match(gate6Task9, /SPX_DB_USERNAME_GATE6_CONTROL:\s*\$\{SPX_DB_USERNAME_GATE6_CONTROL:\?/);
assert.match(gate6Task9, /DB_PASSWORD_FILE:\s*\/run\/secrets\/db_password/);
assert.match(gate6Task9, /GATE6_TASK9_LINE_CALLER_SECRET_FILE:\s*\/run\/secrets\/gate6_task9_line_caller_secret/);
assert.match(gate6Task9, /GATE6_TASK9_OCR_CALLER_SECRET_FILE:\s*\/run\/secrets\/gate6_task9_ocr_caller_secret/);
assert.match(gate6Task9, /command:\s*\["node",\s*"scripts\/production-task9-controller\.mjs"\]/);
assert.match(gate6Task9, /networks:[\s\S]*?default:[\s\S]*?gate6-control-internal:/);
assert.doesNotMatch(gate6Task9, /networks:[\s\S]*?gate6-db-egress:/);
assert.doesNotMatch(
  gate6Task9,
  /docker\.sock|DOCKER_HOST|LINE_TOKEN|OPENAI|CODEX|ANTHROPIC|GOOGLE|AWS|PRIVATE_KEY|SIGNING_KEY|MINT_SECRET/i,
);
assert.deepEqual(secretBindings("gate6-task9-controller"), [
  { source: "db_password_gate6_control", target: "db_password" },
  { source: "gate6_task9_line_caller_secret", target: "gate6_task9_line_caller_secret" },
  { source: "gate6_task9_ocr_caller_secret", target: "gate6_task9_ocr_caller_secret" },
]);

const notificationLineSendSecret = secretBindings("notification-service").find(
  (binding) => binding.target === "line_service_send_secret",
);
const lineServiceSendKeyRing = secretBindings("line-service").find(
  (binding) => binding.target === "line_service_send_node_secrets",
);
assert.equal(
  secretBindings("web-api").some((binding) => binding.target === "line_service_send_secret"),
  false,
);
assert.equal(
  notificationLineSendSecret?.source,
  "line_service_send_secret_notification_service",
);
assert.equal(lineServiceSendKeyRing?.source, "line_service_send_node_secrets");
assert.match(serviceSource("line-service"), /LINE_SERVICE_SEND_NODE_SECRETS_FILE:/);
assert.doesNotMatch(serviceSource("line-service"), /LINE_SERVICE_SEND_SECRET_FILE:/);

assert.equal(existsSync(policyPath), true, "runtime isolation policy missing");
const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
  version: number;
  services: Record<string, {
    requiredSecretFiles: string[];
    allowedSecretFiles: string[];
    mounts: Array<{ id: string; resource: string; path: string; access: string; kind: string }>;
  }>;
};
assert.equal(policy.version, 1);
assert.deepEqual(Object.keys(policy.services).sort(), [...productionServices].sort());

const writableOwners = new Map<string, string>();
for (const service of productionServices) {
  const entry = policy.services[service];
  assert.ok(entry && !service.includes("*"));
  assert.equal(new Set(entry.requiredSecretFiles).size, entry.requiredSecretFiles.length);
  assert.equal(new Set(entry.allowedSecretFiles).size, entry.allowedSecretFiles.length);
  for (const key of entry.requiredSecretFiles) assert.ok(entry.allowedSecretFiles.includes(key));
  for (const [path, resource] of [
    ["/run/secrets/spx-release-manifest", "release-manifest"],
    ["/run/secrets/spx-target-descriptor", "target-descriptor"],
    ["/run/secrets/spx-deployment-context", "deployment-context"],
  ] as const) {
    assert.equal(
      entry.mounts.some((mount) =>
        mount.path === path && mount.resource === resource && mount.access === "read-only"),
      true,
      `${service} policy must authorize ${path}`,
    );
  }

  const source = serviceSource(service);
  const composeFileKeys = [...source.matchAll(/^\s{6}([A-Z][A-Z0-9_]*_FILE):\s*([^\s]+)\s*$/gm)]
    .map((match) => [match[1], match[2]] as const);
  assert.deepEqual(
    composeFileKeys.map(([key]) => key).sort(),
    [...entry.allowedSecretFiles].sort(),
    `${service} Compose/policy secret file keys differ`,
  );
  for (const [key, path] of composeFileKeys) {
    assert.match(key, /^[A-Z][A-Z0-9_]*_FILE$/);
    assert.match(path, /^\/run\/secrets\/[a-z0-9_-]+$/);
    assert.match(source, new RegExp(`target:\\s*${path.slice("/run/secrets/".length)}(?:\\s|$)`));
  }

  assert.ok(Array.isArray(entry.mounts) && entry.mounts.length > 0);
  assert.equal(new Set(entry.mounts.map((mount) => mount.id)).size, entry.mounts.length);
  for (const mount of entry.mounts) {
    assert.match(mount.id, /^[a-z][a-z0-9-]+$/);
    assert.match(mount.resource, /^[a-z][a-z0-9-]+$/);
    assert.ok(mount.path.startsWith("/") && !mount.path.includes("*"));
    assert.ok(["absent", "read-only", "read-write"].includes(mount.access));
    assert.ok(["file", "directory"].includes(mount.kind));
    if (mount.access === "read-write") {
      const existing = writableOwners.get(mount.resource);
      assert.equal(existing, undefined, `${mount.resource} has multiple writable owners`);
      writableOwners.set(mount.resource, service);
    }
  }

  const releaseManifest = entry.mounts.find((mount) => mount.id === "release-manifest");
  assert.deepEqual(
    releaseManifest,
    {
      id: "release-manifest",
      resource: "release-manifest",
      path: "/run/secrets/spx-release-manifest",
      access: "read-only",
      kind: "file",
    },
    `${service} must bind the inherited signed release manifest policy`,
  );

  const actualBindings = volumeBindings(service);
  const expectedTargets = new Set<string>();
  for (const mount of entry.mounts) {
    if (["release-manifest", "target-descriptor", "deployment-context"].includes(mount.id)) continue;
    const target = mountTargets[mount.id];
    assert.ok(target, `${service}/${mount.id} has no Compose target mapping`);
    const actual = actualBindings.find((binding) => binding.target === target);

    if (mount.resource === "image-root-line-images") {
      assert.equal(mount.access, "read-only");
      assert.equal(actual, undefined, `${service} must use the empty read-only image directory`);
      continue;
    }
    if (mount.access === "absent") {
      assert.equal(actual, undefined, `${service}/${mount.id} must not have a Compose mount`);
      continue;
    }

    assert.ok(actual, `${service}/${mount.id} is missing its Compose mount`);
    expectedTargets.add(target);
    if (mount.id === "public-ca") {
      assert.equal(actual.type, "bind");
      assert.equal(actual.source, "${SPX_DB_CA_PATH:?SPX_DB_CA_PATH is required}");
      assert.equal(actual.readOnly, true);
      assert.equal(mount.resource, "public-ca");
    } else if (fixedBindSources[mount.id]) {
      assert.equal(actual.type, "bind");
      assert.equal(actual.source, fixedBindSources[mount.id]);
      assert.equal(actual.readOnly, true);
    } else {
      assert.equal(actual.type, "volume");
      assert.equal(actual.source, mount.resource, `${service}/${mount.id} source must match policy`);
      assert.equal(actual.readOnly, mount.access === "read-only");
    }
  }
  assert.deepEqual(
    actualBindings.map((binding) => binding.target).sort(),
    [...expectedTargets].sort(),
    `${service} has an unmodeled sensitive Compose mount`,
  );
}

assert.equal(
  policy.services["ocr-service"].mounts.find((mount) => mount.id === "ocr-auth")?.access,
  "read-write",
);
assert.deepEqual(
  volumeBindings("ocr-service").find((binding) => binding.target === "/app/data/line-images"),
  {
    type: "volume",
    source: "line-images-split",
    target: "/app/data/line-images",
    readOnly: true,
  },
  "ocr-service must read LINE images through the split read-only volume",
);
assert.equal(
  policy.services["ocr-service"].mounts.find((mount) => mount.id === "line-images")?.resource,
  "line-images-split",
);
assert.equal(
  policy.services["web-api"].mounts.find((mount) => mount.id === "line-images")?.access,
  "read-only",
);
assert.equal(
  policy.services["web-api"].mounts.find((mount) => mount.id === "ocr-auth")?.access,
  "absent",
);

console.log("container-hardening: image, Compose, and exact role policy verified");
