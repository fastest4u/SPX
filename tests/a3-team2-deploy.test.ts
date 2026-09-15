import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const installerSource = readFileSync("scripts/a3-team2-deploy.py", "utf8");
const readinessSource = readFileSync("scripts/a3-team2-readiness.mjs", "utf8");
assert.match(installerSource, /a3-team2-readiness\.mjs/);
assert.match(installerSource, /socket\.create_connection\(\("127\.0\.0\.1", 3000\), timeout=5\)/);
assert.match(
  installerSource,
  /identity\.get\("NOTIFIER_API_URL"\) != "http:\/\/127\.0\.0\.1:3000\/internal\/notification-events"/,
);
assert.match(readinessSource, /servername:\s*process\.env\.DB_SSL_SERVERNAME/);

const normalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(normalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize((value as Record<string, unknown>)[key])]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(normalize(value));
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const root = mkdtempSync(join(tmpdir(), "spx-a3-team2-deploy-"));
try {
  const release = join(root, "releases", "candidate");
  mkdirSync(join(release, "operator", "deploy"), { recursive: true });
  mkdirSync(join(release, "operator", "scripts"), { recursive: true });
  const sourceSha = "a".repeat(40);
  const imageId = `sha256:${"b".repeat(64)}`;
  const operatorBundleSha256 = "c".repeat(64);
  const manifest = {
    imageId,
    imageTag: `spx-app:${sourceSha}`,
    operatorBundleSha256,
    sourceSha,
  };
  const descriptor = {
    schemaVersion: 1,
    descriptor: {
      composeProject: "spx-production",
      database: { accountHosts: { "worker-ifn-split": "172.17.0.1" } },
      deploymentUnit: "team2",
      imageId,
      imageTag: `spx-app:${sourceSha}`,
      nodeIds: ["prod-worker-ifn-node2"],
      operatorBundleSha256,
      publishedPorts: [],
      releaseEnvironment: "production",
      releaseManifestSha256: "pending",
      releaseSourceSha: sourceSha,
      runtimeEnvironment: "production",
      target: {
        canonicalPaths: {
          releaseRoot: "/opt/spx-production-team2",
          environmentFile: "/etc/spx-production/runtime.env",
          stateRoot: "/var/lib/spx-production-team2-rollout",
        },
      },
      topology: "split",
    },
    descriptorSha256: "d".repeat(64),
    signature: { algorithm: "Ed25519", keyId: "test", value: "e".repeat(86) },
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  descriptor.descriptor.releaseManifestSha256 = sha256(manifestBytes);
  const descriptorBytes = Buffer.from(canonical(descriptor));
  writeFileSync(join(release, "release-manifest.json"), manifestBytes);
  writeFileSync(join(release, "deployment-target-descriptor.json"), descriptorBytes);
  writeFileSync(join(release, "spx-image.tar"), "fixture-image");
  cpSync("deploy/production-topology.json", join(release, "operator", "deploy", "production-topology.json"));
  cpSync("deploy/production-team2.yml", join(release, "operator", "deploy", "production-team2.yml"));
  cpSync("scripts/a3-team2-readiness.mjs", join(release, "operator", "scripts", "a3-team2-readiness.mjs"));

  const run = (extra: string[] = []) => spawnSync("python", [
    "scripts/a3-team2-deploy.py", "validate",
    `--release-dir=${release}`,
    `--release-manifest-sha256=${sha256(manifestBytes)}`,
    `--target-descriptor-sha256=${sha256(descriptorBytes)}`,
    ...extra,
  ], { encoding: "utf8" });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    deploymentUnit: "team2",
    nodeId: "prod-worker-ifn-node2",
    ok: true,
    service: "worker-ifn-split",
    teamId: 2,
  });

  const wrongPaths = JSON.parse(readFileSync(join(release, "deployment-target-descriptor.json"), "utf8"));
  wrongPaths.descriptor.target.canonicalPaths.releaseRoot = "/opt/spx-production/release";
  const wrongPathBytes = Buffer.from(canonical(wrongPaths));
  writeFileSync(join(release, "deployment-target-descriptor.json"), wrongPathBytes);
  const invalidPaths = run([`--target-descriptor-sha256=${sha256(wrongPathBytes)}`]);
  assert.equal(invalidPaths.status, 1);
  assert.match(invalidPaths.stderr, /canonical paths/);
  writeFileSync(join(release, "deployment-target-descriptor.json"), descriptorBytes);

  const wrongUnit = JSON.parse(readFileSync(join(release, "deployment-target-descriptor.json"), "utf8"));
  wrongUnit.descriptor.deploymentUnit = "primary";
  const wrongBytes = Buffer.from(canonical(wrongUnit));
  writeFileSync(join(release, "deployment-target-descriptor.json"), wrongBytes);
  const invalid = run([`--target-descriptor-sha256=${sha256(wrongBytes)}`]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /TEAM 2 target descriptor/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("A3 TEAM 2 deploy payload validation passes");
