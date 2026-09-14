import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildStagingDatabaseConnectionConfig,
  databaseSecretPath,
  loadStagingDatabaseCredential,
  readRootOwnedStagingSecret,
  STAGING_PROVISIONED_DB_ROLES,
  validateStagingActionCapability,
} from "../scripts/lib/staging-action-capability.mjs";

const H = (value: string) => value.repeat(64);
const CA_BYTES = Buffer.from("test-ca");
const binding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: H("c"),
  environment: "staging",
  topology: "split",
  composeProject: "spx-staging",
  stagingTargetDescriptorSha256: H("d"),
  operatorBundleSha256: H("e"),
  stagingApprovalEnvelopeSha256: H("f"),
  actionJournalHeadSha256: H("1"),
  stagingRunId: "staging-run-001",
};
const releaseIdentity = Object.fromEntries(
  Object.entries(binding).filter(([key]) => key !== "actionJournalHeadSha256"),
);
const capability = {
  schemaVersion: 1,
  releaseBinding: releaseIdentity,
  database: {
    host: "mysql.staging.internal",
    port: 3306,
    name: "spx_staging",
    sslServername: "mysql.staging.internal",
    caSha256: createHash("sha256").update(CA_BYTES).digest("hex"),
    actors: {
      bootstrap: "spx_staging_bootstrap",
      phase3Control: "spx_stg_phase3_control",
    },
    actorHosts: {
      bootstrap: "172.17.0.1",
      phase3Control: "172.17.0.1",
    },
    principalRoles: STAGING_PROVISIONED_DB_ROLES,
  },
  phase3: {
    canaryTeamId: 2,
    canaryEpoch: "phase3-ifn-20260710",
  },
};

async function main(): Promise<void> {
  assert.deepEqual(validateStagingActionCapability(capability, binding), capability);
  assert.equal(STAGING_PROVISIONED_DB_ROLES.includes("phase3-observer"), true);
  assert.throws(
    () => validateStagingActionCapability(
      { ...capability, database: { ...capability.database, name: "spx" } },
      binding,
    ),
    /database|staging/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      { ...capability, releaseBinding: { ...binding, candidateSha: "9".repeat(40) } },
      binding,
    ),
    /binding/i,
  );
  assert.throws(
    () => validateStagingActionCapability({ ...capability, callerPath: "/tmp/override" }, binding),
    /field|capability/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      { ...capability, phase3: { ...capability.phase3, canaryEpoch: "$(unsafe)" } },
      binding,
    ),
    /epoch|phase 3/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      { ...capability, phase3: { ...capability.phase3, canaryTeamId: 3 } },
      binding,
    ),
    /canary|team|phase 3/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      { ...capability, phase3: { ...capability.phase3, partition: "ifn" } },
      binding,
    ),
    /field|phase 3|capability/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      {
        ...capability,
        database: {
          ...capability.database,
          principalRoles: capability.database.principalRoles.filter((role) => role !== "worker-ifn"),
        },
      },
      binding,
    ),
    /database|principal|role/i,
  );
  assert.throws(
    () => validateStagingActionCapability(
      {
        ...capability,
        database: {
          ...capability.database,
          actors: { ...capability.database.actors, bootstrap: "other_bootstrap" },
        },
      },
      binding,
    ),
    /actor|database/i,
  );

  assert.equal(
    databaseSecretPath("bootstrap"),
    "/run/spx-staging-actions/database/bootstrap.password",
  );
  assert.equal(
    databaseSecretPath("principal", "worker-ifn-split"),
    "/run/spx-staging-actions/database/principal-worker-ifn-split.password",
  );
  assert.equal(
    databaseSecretPath("principal", "phase3-observer"),
    "/run/spx-staging-actions/database/principal-phase3-observer.password",
  );
  assert.throws(() => databaseSecretPath("principal", "../../production"), /role|secret/i);

  const temp = await mkdtemp(join(tmpdir(), "spx-staging-capability-"));
  const secretRoot = join(temp, "database");
  const secretPath = join(secretRoot, "bootstrap.password");
  const caPath = join(temp, "db-ca.pem");
  const expectedUid = process.platform === "win32" ? null : process.getuid!();
  try {
    await mkdir(secretRoot, { mode: 0o700 });
    await writeFile(secretPath, "x".repeat(40), { mode: 0o400 });
    await writeFile(caPath, "test-ca", { mode: 0o400 });
    if (process.platform !== "win32") {
      await chmod(secretRoot, 0o700);
      await chmod(secretPath, 0o400);
      await chmod(caPath, 0o400);
    }
    assert.equal(
      await readRootOwnedStagingSecret(secretPath, { expectedUid, allowedRoot: secretRoot }),
      "x".repeat(40),
    );
    await assert.rejects(
      readRootOwnedStagingSecret(join(temp, "outside.password"), {
        expectedUid,
        allowedRoot: secretRoot,
      }),
      /root|path|secret/i,
    );
    const database = buildStagingDatabaseConnectionConfig(
      capability,
      "bootstrap",
      "x".repeat(40),
      CA_BYTES,
    );
    assert.deepEqual(database, {
      host: "mysql.staging.internal",
      port: 3306,
      user: "spx_staging_bootstrap",
      password: "x".repeat(40),
      database: "spx_staging",
      ssl: {
        ca: "test-ca",
        rejectUnauthorized: true,
        servername: "mysql.staging.internal",
      },
    });
    assert.equal(
      buildStagingDatabaseConnectionConfig(
        capability,
        "phase3-observer",
        "x".repeat(40),
        CA_BYTES,
      ).user,
      "spx_stg_phase3_observer",
    );
    assert.equal(
      (
        await loadStagingDatabaseCredential(capability, "bootstrap", {
          expectedUid,
          allowedRoot: secretRoot,
          secretPath,
          caPath,
        })
      ).user,
      "spx_staging_bootstrap",
    );
    if (process.platform !== "win32") {
      await chmod(caPath, 0o644);
      await assert.rejects(
        loadStagingDatabaseCredential(capability, "bootstrap", {
          expectedUid,
          allowedRoot: secretRoot,
          secretPath,
          caPath,
        }),
        /CA|root|private|permission/i,
      );
    }
  } finally {
    await chmod(secretRoot, 0o700).catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
