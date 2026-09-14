import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scriptPath = resolve("scripts/container-inventory-check.mjs");
assert.equal(existsSync(scriptPath), true, "trusted host inventory validator is missing");

async function main(): Promise<void> {
const { evaluateContainerInventory } = await import(pathToFileURL(scriptPath).href) as {
  evaluateContainerInventory(input: {
    service: string;
    project: string;
    compose: unknown;
    inspect: unknown;
    policy: unknown;
  }): { ok: boolean; service: string; failureCodes: string[] };
};

const privateRoot = "/private/host-inventory-fixture";
const policy = {
  version: 1,
  services: {
    "web-api": {
      requiredSecretFiles: ["DB_PASSWORD_FILE"],
      allowedSecretFiles: ["DB_PASSWORD_FILE"],
      mounts: [
        {
          id: "release-manifest",
          resource: "release-manifest",
          path: "/run/secrets/spx-release-manifest",
          access: "read-only",
          kind: "file",
        },
        {
          id: "public-ca",
          resource: "public-ca",
          path: "/run/config/db-ca.pem",
          access: "read-only",
          kind: "file",
        },
        {
          id: "line-images",
          resource: "line-images-split",
          path: "/app/data/line-images",
          access: "read-only",
          kind: "directory",
        },
        {
          id: "notification-spool",
          resource: "notification-spool-any",
          path: "/app/spool/notification-spool.jsonl",
          access: "absent",
          kind: "file",
        },
      ],
    },
  },
};

const compose = {
  name: "spx-production",
  services: {
    "web-api": {
      configs: [
        {
          source: "spx_release_manifest",
          target: "/run/secrets/spx-release-manifest",
          mode: "0444",
        },
      ],
      secrets: [
        {
          source: "db_password_web_api",
          target: "db_password",
          mode: "0444",
        },
      ],
      tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m"],
      volumes: [
        {
          type: "bind",
          source: `${privateRoot}/db-ca.pem`,
          target: "/run/config/db-ca.pem",
          read_only: true,
        },
        {
          type: "volume",
          source: "line-images-split",
          target: "/app/data/line-images",
          read_only: true,
        },
      ],
    },
  },
  configs: {
    spx_release_manifest: {
      name: "spx-production_spx_release_manifest",
      file: `${privateRoot}/release-manifest.json`,
    },
    unused_config: {
      name: "spx-production_unused_config",
      file: `${privateRoot}/unused-config.json`,
    },
  },
  secrets: {
    db_password_web_api: {
      name: "spx-production_db_password_web_api",
      file: `${privateRoot}/db-password`,
    },
    unused_secret: {
      name: "spx-production_unused_secret",
      file: `${privateRoot}/unused-secret`,
    },
  },
  volumes: {
    "line-images-split": {
      name: "spx-production_line-images-split",
    },
  },
};

const inspect = {
  project: "spx-production",
  service: "web-api",
  mounts: [
    {
      Type: "bind",
      Source: `${privateRoot}/release-manifest.json`,
      Destination: "/run/secrets/spx-release-manifest",
      RW: false,
    },
    {
      Type: "bind",
      Source: `${privateRoot}/db-password`,
      Destination: "/run/secrets/db_password",
      RW: false,
    },
    {
      Type: "bind",
      Source: `${privateRoot}/db-ca.pem`,
      Destination: "/run/config/db-ca.pem",
      RW: false,
    },
    {
      Type: "volume",
      Name: "spx-production_line-images-split",
      Source: "/var/lib/docker/volumes/private/_data",
      Destination: "/app/data/line-images",
      RW: false,
    },
  ],
  tmpfs: {
    "/tmp": "rw,noexec,nosuid,nodev,size=64m",
  },
};

function evaluate(actual: unknown = inspect, expectedCompose: unknown = compose) {
  return evaluateContainerInventory({
    service: "web-api",
    project: "spx-production",
    compose: expectedCompose,
    inspect: actual,
    policy,
  });
}

function withExtraMount(mount: Record<string, unknown>) {
  const actual = structuredClone(inspect);
  actual.mounts.push(mount as typeof actual.mounts[number]);
  return actual;
}

assert.deepEqual(evaluate(), { ok: true, service: "web-api", failureCodes: [] });

for (const actual of [
  withExtraMount({
    Type: "bind",
    Source: `${privateRoot}/unexpected-bind`,
    Destination: "/unexpected-bind",
    RW: false,
  }),
  withExtraMount({
    Type: "volume",
    Name: "spx-production_unexpected-volume",
    Source: "/var/lib/docker/volumes/unexpected/_data",
    Destination: "/unexpected-volume",
    RW: true,
  }),
  withExtraMount({
    Type: "bind",
    Source: compose.secrets.unused_secret.file,
    Destination: "/run/secrets/unused_secret",
    RW: false,
  }),
  withExtraMount({
    Type: "bind",
    Source: compose.configs.unused_config.file,
    Destination: "/run/config/unused.json",
    RW: false,
  }),
  {
    ...structuredClone(inspect),
    tmpfs: {
      ...inspect.tmpfs,
      "/unexpected-tmpfs": "rw,nosuid,nodev",
    },
  },
]) {
  assert.deepEqual(evaluate(actual), {
    ok: false,
    service: "web-api",
    failureCodes: ["inventory_extra_mount"],
  });
}

const missing = structuredClone(inspect);
missing.mounts = missing.mounts.filter(
  (mount) => mount.Destination !== "/run/secrets/db_password",
);
assert.deepEqual(evaluate(missing).failureCodes, ["inventory_missing_mount"]);

const wrongSource = structuredClone(inspect);
wrongSource.mounts[1].Source = `${privateRoot}/WRONG_PRIVATE_SOURCE`;
assert.deepEqual(evaluate(wrongSource).failureCodes, ["inventory_source_mismatch"]);

const wrongTarget = structuredClone(inspect);
wrongTarget.mounts[1].Destination = "/run/secrets/wrong-target";
assert.deepEqual(evaluate(wrongTarget).failureCodes, ["inventory_target_mismatch"]);

const wrongAccess = structuredClone(inspect);
wrongAccess.mounts[1].RW = true;
assert.deepEqual(evaluate(wrongAccess).failureCodes, ["inventory_access_mismatch"]);

const wrongType = structuredClone(inspect);
wrongType.mounts[3] = {
  Type: "bind",
  Source: `${privateRoot}/line-images-split`,
  Destination: "/app/data/line-images",
  RW: false,
} as typeof wrongType.mounts[number];
assert.deepEqual(evaluate(wrongType).failureCodes, ["inventory_type_mismatch"]);

const weakTmpfs = structuredClone(inspect);
weakTmpfs.tmpfs["/tmp"] = "rw,nosuid,nodev,size=64m";
assert.deepEqual(evaluate(weakTmpfs).failureCodes, ["inventory_options_mismatch"]);

const wrongIdentity = structuredClone(inspect);
wrongIdentity.project = "other-project";
assert.deepEqual(evaluate(wrongIdentity).failureCodes, ["inventory_identity_mismatch"]);

const policyDriftCompose = structuredClone(compose);
policyDriftCompose.services["web-api"].volumes.push({
  type: "bind",
  source: `${privateRoot}/policy-drift`,
  target: "/not-approved-by-policy",
  read_only: true,
});
assert.deepEqual(evaluate(inspect, policyDriftCompose).failureCodes, [
  "inventory_policy_mismatch",
]);

const temp = mkdtempSync(join(tmpdir(), "spx-container-inventory-"));
try {
  const composePath = join(temp, "compose.json");
  const inspectPath = join(temp, "inspect.json");
  const policyPath = join(temp, "policy.json");
  writeFileSync(composePath, JSON.stringify(compose), { mode: 0o600 });
  writeFileSync(inspectPath, JSON.stringify(wrongSource), { mode: 0o600 });
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const cli = spawnSync(process.execPath, [
    scriptPath,
    "--service=web-api",
    "--project=spx-production",
    `--compose-json=${composePath}`,
    `--inspect-json=${inspectPath}`,
    `--policy=${policyPath}`,
  ], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(cli.status, 1, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), {
    ok: false,
    service: "web-api",
    failureCodes: ["inventory_source_mismatch"],
  });
  assert.doesNotMatch(`${cli.stdout}\n${cli.stderr}`, /WRONG_PRIVATE_SOURCE|private\/host/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("container inventory check tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
