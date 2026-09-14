import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKUP_EVIDENCE_FILE,
  BACKUP_SIGNATURE_FILE,
  runProductionBackupRestore,
  writeProductionBackupRestoreArtifactsForTest,
} from "../scripts/production-backup-restore-controller.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";

const H = (character: string): string => character.repeat(64);

function quiescenceObservation(phase: string, observedAt: string) {
  const core = {
    phase,
    observedAt,
    hostLockState: "absent",
    gate6DatabaseSlotState: "absent",
  };
  return { ...core, observationSha256: sha256Canonical(core) };
}

const validContext = {
  schemaVersion: 1,
  operationId: "018f3f68-8b9b-7f62-9d1a-ef8c9c748001",
  candidateSha: "a".repeat(40),
  releaseManifestSha256: H("b"),
  targetDescriptorSha256: H("c"),
  databaseFingerprint: `sha256:${H("d")}`,
  createdAt: "2026-07-16T00:00:00.000Z",
  limits: {
    maximumAgeMinutes: 30,
    maximumRpoMinutes: 5,
    maximumRtoMinutes: 20,
  },
  producer: {
    repository: "fastest4u/SPX",
    environment: "production",
    workflow: ".github/workflows/trusted-production-backup-restore.yml",
    workflowSha: "e".repeat(40),
    workflowFileSha256: H("f"),
  },
  implementationSha256: {
    controllerSha256: H("1"),
    liveAdapterSha256: H("2"),
    invariantDefinitionsSha256: H("3"),
    isolatedComposeSha256: H("4"),
  },
  sourceCredentialSha256: H("5"),
  kmsCapabilitySha256: H("6"),
  kmsKeyId: "spx-production-backup-v1",
  evidenceSigningKeyId: "spx-production-backup-evidence-v1",
  isolatedMysqlImageDigest: `mysql@sha256:${H("7")}`,
  executableSha256: {
    mysqldump: H("8"),
    mysql: H("9"),
    docker: H("a"),
    kmsEnvelope: H("b"),
  },
};

type Overrides = Partial<{
  beforeQuiescence: Record<string, unknown>;
  fingerprint: Record<string, unknown>;
  backup: Record<string, unknown>;
  boundary: Record<string, unknown>;
  restore: Record<string, unknown>;
  invariants: Record<string, unknown>;
  rowDigest: Record<string, unknown>;
  teardown: Record<string, unknown>;
  afterQuiescence: Record<string, unknown>;
  backupError: Error;
  restoreError: Error;
}>;

function makeAdapter(overrides: Overrides = {}) {
  const calls: string[] = [];
  let teardownComplete = false;
  const beforeQuiescence =
    overrides.beforeQuiescence ??
    quiescenceObservation("before-capture", "2026-07-16T00:01:00.000Z");
  const afterQuiescence =
    overrides.afterQuiescence ??
    quiescenceObservation("after-teardown", "2026-07-16T00:09:00.000Z");
  return {
    calls,
    adapter: {
      async recoverAbandonedOperation() {
        calls.push("recover-abandoned-operation");
      },
      async assertMutationQuiescent(phase: string) {
        calls.push(`assert-mutation-quiescent:${phase}`);
        return phase === "before-capture" ? beforeQuiescence : afterQuiescence;
      },
      async readProductionFingerprint() {
        calls.push("read-production-fingerprint");
        return (
          overrides.fingerprint ?? {
            databaseFingerprint: validContext.databaseFingerprint,
            capturedAt: "2026-07-16T00:02:00.000Z",
          }
        );
      },
      async createEncryptedBackup() {
        calls.push("create-encrypted-backup");
        if (overrides.backupError) throw overrides.backupError;
        return (
          overrides.backup ?? {
            backupSha256: H("e"),
            encryptionMetadataSha256: H("f"),
            createdAt: "2026-07-16T00:03:00.000Z",
            encrypted: true,
            beforeDdl: true,
            databaseFingerprint: validContext.databaseFingerprint,
          }
        );
      },
      async startIsolatedRestore() {
        calls.push("start-isolated-restore");
        return (
          overrides.boundary ?? {
            environment: "isolated",
            productionRoutesPresent: false,
            providerCredentialsPresent: false,
            backgroundServicesPresent: false,
            sharedWritableVolumesPresent: false,
          }
        );
      },
      async restoreBackup() {
        calls.push("restore-backup");
        if (overrides.restoreError) throw overrides.restoreError;
        return (
          overrides.restore ?? {
            databaseFingerprint: `sha256:${H("1")}`,
            restoredSchemaSha256: H("2"),
          }
        );
      },
      async verifyFixedInvariants() {
        calls.push("verify-fixed-invariants");
        return (
          overrides.invariants ?? {
            invariantDefinitionsSha256:
              validContext.implementationSha256.invariantDefinitionsSha256,
            invariantResultsSha256: H("3"),
          }
        );
      },
      async captureSanitizedRowCountDigest() {
        calls.push("capture-row-count-digest");
        return overrides.rowDigest ?? { rowCountDigestSha256: H("4") };
      },
      async destroyIsolatedRestore() {
        calls.push("destroy-isolated-restore");
        const result = overrides.teardown ?? {
          teardownProven: true,
          destroyedAt: "2026-07-16T00:08:00.000Z",
        };
        teardownComplete = result.teardownProven === true;
        return result;
      },
      async signEvidenceCore(core: unknown) {
        calls.push("sign-evidence");
        assert.equal(teardownComplete, true, "signing must follow proven teardown");
        assert.doesNotMatch(canonicalJson(core), /signatureSha256/);
        return {
          schemaVersion: 1,
          algorithm: "kms-sha256",
          keyId: validContext.evidenceSigningKeyId,
          subjectSha256: sha256Canonical(core),
          signatureBase64: Buffer.from("signed production backup evidence").toString("base64"),
          signedAt: "2026-07-16T00:10:00.000Z",
        };
      },
    },
  };
}

async function main() {
  {
    const fake = makeAdapter();
    const evidence = await runProductionBackupRestore(validContext, fake.adapter);
    assert.deepEqual(fake.calls, [
      "recover-abandoned-operation",
      "assert-mutation-quiescent:before-capture",
      "read-production-fingerprint",
      "create-encrypted-backup",
      "start-isolated-restore",
      "restore-backup",
      "verify-fixed-invariants",
      "capture-row-count-digest",
      "destroy-isolated-restore",
      "assert-mutation-quiescent:after-teardown",
      "sign-evidence",
    ]);
    assert.equal(evidence.beforeDdl, true);
    assert.equal(evidence.encrypted, true);
    assert.equal(evidence.isolatedRestore.productionRoutesPresent, false);
    assert.equal(evidence.isolatedRestore.providerCredentialsPresent, false);
    assert.equal(evidence.isolatedRestore.backgroundServicesPresent, false);
    assert.equal(evidence.isolatedRestore.sharedWritableVolumesPresent, false);
    assert.equal(evidence.isolatedRestore.teardownProven, true);
    assert.equal(evidence.rpoMinutes, 1);
    assert.equal(evidence.rtoMinutes, 6);
    assert.equal("phase" in evidence.quiescence.beforeCapture, false);
    assert.equal("phase" in evidence.quiescence.afterTeardown, false);
    assert.match(evidence.signatureSha256, /^[0-9a-f]{64}$/);
  }

  {
    const root = await mkdtemp(join(tmpdir(), "spx-backup-artifacts-existing-"));
    await chmod(root, 0o700);
    const evidencePath = join(root, BACKUP_EVIDENCE_FILE);
    const signaturePath = join(root, BACKUP_SIGNATURE_FILE);
    const sentinel = "pre-existing-evidence\n";
    try {
      await writeFile(evidencePath, sentinel, { mode: 0o400, flag: "wx" });
      await assert.rejects(
        writeProductionBackupRestoreArtifactsForTest(
          { schemaVersion: 1 },
          { schemaVersion: 1 },
          root,
        ),
        /exist|create/i,
      );
      assert.equal(await readFile(evidencePath, "utf8"), sentinel);
      await assert.rejects(readFile(signaturePath), /ENOENT/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  {
    const root = await mkdtemp(join(tmpdir(), "spx-backup-artifacts-new-"));
    await chmod(root, 0o700);
    const evidence = { schemaVersion: 1, value: "evidence" };
    const signature = { schemaVersion: 1, value: "signature" };
    try {
      const persisted = await writeProductionBackupRestoreArtifactsForTest(
        evidence,
        signature,
        root,
      );
      assert.deepEqual(persisted, {
        evidenceSha256: sha256Canonical(evidence),
        signatureSha256: sha256Canonical(signature),
      });
      assert.equal(
        await readFile(join(root, BACKUP_EVIDENCE_FILE), "utf8"),
        canonicalJson(evidence),
      );
      assert.equal(
        await readFile(join(root, BACKUP_SIGNATURE_FILE), "utf8"),
        canonicalJson(signature),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function rejects(overrides: Overrides, pattern: RegExp) {
    const fake = makeAdapter(overrides);
    await assert.rejects(runProductionBackupRestore(validContext, fake.adapter), pattern);
    assert.equal(fake.calls.includes("sign-evidence"), false);
    return fake.calls;
  }

  await rejects(
    {
      backup: {
        backupSha256: H("e"),
        encryptionMetadataSha256: H("f"),
        createdAt: "2026-07-16T00:03:00.000Z",
        encrypted: true,
        beforeDdl: true,
        databaseFingerprint: `sha256:${H("0")}`,
      },
    },
    /fingerprint/i,
  );

  await rejects(
    {
      restore: {
        databaseFingerprint: validContext.databaseFingerprint,
        restoredSchemaSha256: H("2"),
      },
    },
    /isolated.*fingerprint/i,
  );

  await rejects(
    {
      teardown: { teardownProven: false, destroyedAt: "2026-07-16T00:08:00.000Z" },
    },
    /teardown/i,
  );

  await rejects(
    {
      backup: {
        backupSha256: H("e"),
        encryptionMetadataSha256: H("f"),
        createdAt: "2026-07-16T00:03:00.000Z",
        encrypted: true,
        beforeDdl: false,
        databaseFingerprint: validContext.databaseFingerprint,
      },
    },
    /before DDL/i,
  );

  await rejects(
    {
      fingerprint: {
        databaseFingerprint: validContext.databaseFingerprint,
        capturedAt: "2026-07-16T00:02:00.000Z",
      },
      backup: {
        backupSha256: H("e"),
        encryptionMetadataSha256: H("f"),
        createdAt: "2026-07-16T00:08:00.000Z",
        encrypted: true,
        beforeDdl: true,
        databaseFingerprint: validContext.databaseFingerprint,
      },
    },
    /RPO/i,
  );

  await rejects(
    {
      afterQuiescence: quiescenceObservation("after-teardown", "2026-07-16T00:29:00.000Z"),
    },
    /RTO/i,
  );

  await rejects(
    {
      rowDigest: { rowCountDigestSha256: H("4"), tableCounts: { users: 42 } },
    },
    /exact keys/i,
  );

  await rejects(
    {
      invariants: {
        invariantDefinitionsSha256: validContext.implementationSha256.invariantDefinitionsSha256,
        invariantResultsSha256: H("3"),
        rawSql: "SELECT COUNT(*) FROM users",
      },
    },
    /exact keys/i,
  );

  await rejects(
    {
      boundary: {
        environment: "isolated",
        productionRoutesPresent: true,
        providerCredentialsPresent: false,
        backgroundServicesPresent: false,
        sharedWritableVolumesPresent: false,
      },
    },
    /isolated restore boundary/i,
  );

  await rejects(
    {
      boundary: {
        environment: "isolated",
        productionRoutesPresent: false,
        providerCredentialsPresent: true,
        backgroundServicesPresent: false,
        sharedWritableVolumesPresent: false,
      },
    },
    /isolated restore boundary/i,
  );

  for (const forbidden of ["path", "sql", "database", "service"]) {
    const fake = makeAdapter();
    await assert.rejects(
      runProductionBackupRestore({ ...validContext, [forbidden]: "caller-selected" }, fake.adapter),
      /exact keys/i,
    );
    assert.deepEqual(fake.calls, []);
  }

  await rejects(
    {
      beforeQuiescence: {
        phase: "before-capture",
        observedAt: "2026-07-16T00:01:00.000Z",
        hostLockState: "active",
        gate6DatabaseSlotState: "absent",
        observationSha256: H("c"),
      },
    },
    /quiescent/i,
  );

  await rejects(
    {
      afterQuiescence: {
        phase: "after-teardown",
        observedAt: "2026-07-16T00:09:00.000Z",
        hostLockState: "absent",
        gate6DatabaseSlotState: "sealed",
        observationSha256: H("d"),
      },
    },
    /quiescent/i,
  );

  await rejects(
    {
      beforeQuiescence: quiescenceObservation("after-teardown", "2026-07-16T00:01:00.000Z"),
    },
    /phase|quiescence/i,
  );

  {
    const fake = makeAdapter({ backupError: new Error("backup-capture-failed-after-arming") });
    await assert.rejects(
      runProductionBackupRestore(validContext, fake.adapter),
      /backup-capture-failed-after-arming/,
    );
    assert.equal(fake.calls.includes("destroy-isolated-restore"), true);
    assert.equal(fake.calls.includes("assert-mutation-quiescent:after-teardown"), true);
    assert.equal(fake.calls.includes("sign-evidence"), false);
  }

  {
    const fake = makeAdapter({ restoreError: new Error("restore-failed") });
    await assert.rejects(runProductionBackupRestore(validContext, fake.adapter), /restore-failed/);
    assert.equal(fake.calls.includes("destroy-isolated-restore"), true);
    assert.equal(fake.calls.includes("assert-mutation-quiescent:after-teardown"), true);
    assert.equal(fake.calls.includes("sign-evidence"), false);
  }

  console.log("production backup restore controller tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
