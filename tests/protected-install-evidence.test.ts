/* eslint-disable @typescript-eslint/no-explicit-any -- crash-recovery fixtures deliberately mutate invalid persisted shapes */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_INSTALL_INPUT_FILES,
  PROTECTED_INSTALL_PATHS,
  assembleProtectedInstallEvidence,
  commitProtectedInstallEvidence,
  prepareProtectedInstallEvidenceCommit,
  runProtectedInstallEvidenceCli,
  verifyProtectedInstallEvidence,
} from "../scripts/protected-install-evidence.mjs";
import { canonicalJson, sha256Canonical } from "../scripts/lib/evidence-artifact.mjs";

const digest = (label: string): string => createHash("sha256").update(label).digest("hex");
const image = (label: string): string => `sha256:${digest(label)}`;
const BASELINE_SERVICES = [
  "line-service",
  "notification-service",
  "ocr-service",
  "web-api",
  "worker-ptwl-split",
] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validUnsignedInput() {
  const operationId = "install-production-20260716";
  const candidateSha = "a".repeat(40);
  const rollbackSha = "b".repeat(40);
  const releaseManifestSha256 = digest("release-manifest");
  const targetDescriptorSha256 = digest("production-target");
  const operatorBundleSha256 = digest("operator-bundle");
  const databaseFingerprint = image("production-database");
  const migrations = [
    { name: "035_create_auto_accept_publication_controls.sql", sha256: digest("migration-035") },
    { name: "036_create_gate6_control_plane.sql", sha256: digest("migration-036") },
  ];
  const migrationSetSha256 = createHash("sha256")
    .update(migrations.map(({ name, sha256 }) => `${name}:${sha256}`).join("\n"))
    .digest("hex");
  const backupRestoreEvidenceSha256 = digest("backup-evidence");
  const release = {
    sourceSha: candidateSha,
    imageId: image("candidate-image"),
    operatorBundleSha256,
    schema: { min: 34, max: 36 },
    migrations,
    migrationSetSha256,
  };
  const serviceActivationCore = {
    operationId,
    phase34ProfilesStopped: true,
    entries: BASELINE_SERVICES.map((service) => ({
      service,
      activated: true,
      identityVerified: true,
      ready: true,
      watermarkPassed: true,
    })),
  };
  const watchdogCore = {
    operationId,
    startedAt: "2026-07-16T01:00:00.000Z",
    firstMutationAt: "2026-07-16T01:01:00.000Z",
    lastHeartbeatAt: "2026-07-16T01:08:00.000Z",
    finalizedAt: "2026-07-16T01:09:00.000Z",
    startedBeforeMutation: true,
    continuous: true,
    terminal: true,
  };
  return {
    schemaVersion: 1,
    releaseEnvironment: "production",
    operationId,
    releaseManifestSha256,
    release,
    rollback: {
      releaseManifestSha256: digest("rollback-release-manifest"),
      sourceSha: rollbackSha,
      imageId: image("rollback-image"),
      schema: { min: 34, max: 36 },
    },
    target: {
      descriptorSha256: targetDescriptorSha256,
      releaseManifestSha256,
      releaseSourceSha: candidateSha,
      imageId: release.imageId,
      operatorBundleSha256,
      databaseFingerprint,
    },
    installed: {
      candidateSha,
      imageDigest: release.imageId,
      targetDescriptorSha256,
      operatorBundleSha256,
      databaseFingerprint,
      schemaVersion: release.schema.max,
      migrationSetSha256,
    },
    backupEvidence: {
      evidenceSha256: backupRestoreEvidenceSha256,
      candidateSha,
      releaseManifestSha256,
      targetDescriptorSha256,
      databaseFingerprint,
      backupSha256: digest("encrypted-backup"),
      beforeDdl: true,
      encrypted: true,
      isolatedRestore: true,
      teardownProven: true,
    },
    migrationReceipt: {
      ok: true,
      beforeSchema: 34,
      afterSchema: 36,
      installedMigrationSetSha256: migrationSetSha256,
      pendingReleasedMigrationCount: 0,
      backupRestoreEvidenceSha256,
      rollbackSchemaCompatible: true,
      checksumSetExact: true,
    },
    classifiedPendingAlters: [
      {
        migration: "035_create_auto_accept_publication_controls.sql",
        migrationSha256: digest("migration-035"),
        algorithm: "INPLACE",
        lock: "NONE",
      },
    ],
    onlineDdlReceipts: [
      {
        migration: "035_create_auto_accept_publication_controls.sql",
        migrationSha256: digest("migration-035"),
        tableSizeBucket: "10m-100m",
        algorithm: "INPLACE",
        lock: "NONE",
        implicitFallback: false,
        durationMs: 5_000,
        maximumDurationMs: 30_000,
        latencyBudgetPassed: true,
        ioBudgetPassed: true,
        connectionBudgetPassed: true,
        rehearsalMysqlVersion: "8.4.0",
      },
    ],
    grantEvidence: {
      operationId,
      positiveGrantProofSha256: digest("positive-grants"),
      forbiddenGrantProofSha256: digest("forbidden-grants"),
      bootstrapPrincipalEvidenceSha256: digest("bootstrap-principals"),
    },
    serviceActivationJournal: {
      ...serviceActivationCore,
      journalSha256: sha256Canonical(serviceActivationCore),
    },
    watchdogJournal: {
      ...watchdogCore,
      journalSha256: sha256Canonical(watchdogCore),
    },
    healthEvidence: {
      operationId,
      candidateSha,
      imageDigest: release.imageId,
      activatedServices: [...BASELINE_SERVICES],
      evidenceSha256: digest("health-evidence"),
      passed: true,
    },
    watermarkEvidence: {
      operationId,
      activatedServices: [...BASELINE_SERVICES],
      evidenceSha256: digest("watermark-evidence"),
      passed: true,
    },
    rollbackReadiness: {
      operationId,
      rollbackSha,
      rollbackImageDigest: image("rollback-image"),
      evidenceSha256: digest("rollback-readiness"),
      schemaCompatible: true,
      ready: true,
    },
    hostLock: {
      operationId,
      state: "installing",
      version: 7,
      releaseSha: candidateSha,
      targetDescriptorSha256,
      operatorBundleSha256,
    },
    databaseSlot: {
      operationId,
      state: "installing",
      version: 11,
      releaseSha: candidateSha,
      targetDescriptorSha256,
      operatorBundleSha256,
      installedMigrationSetSha256: migrationSetSha256,
      installedSchemaVersion: release.schema.max,
    },
    finalLease: {
      heartbeatAt: "2026-07-16T01:10:00.000Z",
      expiresAt: "2026-07-17T01:10:00.000Z",
    },
    issuedAt: "2026-07-16T01:10:00.000Z",
    producer: {
      repository: "fastest4u/SPX",
      environment: "production",
      workflow: ".github/workflows/trusted-deploy.yml",
      workflowSha: "c".repeat(40),
      workflowFileSha256: digest("trusted-deploy-workflow"),
    },
  };
}

function signingContextFor(_input: ReturnType<typeof validUnsignedInput>) {
  return {
    schemaVersion: 1,
    kmsExecutableSha256: digest("protected-install-kms-executable"),
    kmsCapabilitySha256: digest("protected-install-kms-capability"),
    evidenceSigningKeyId: "spx-production-install-evidence-v1",
    signedAt: "2026-07-16T01:10:01.000Z",
  };
}

function signatureFor(prepared: ReturnType<typeof prepareProtectedInstallEvidenceCommit>) {
  return {
    schemaVersion: 1,
    algorithm: "kms-sha256",
    keyId: prepared.signatureRequest.keyId,
    subjectSha256: prepared.signatureRequest.subjectSha256,
    signatureBase64: Buffer.from("fixed-protected-kms-signature").toString("base64"),
    signedAt: "2026-07-16T01:10:01.000Z",
  };
}

function validSignedFixture() {
  const input = validUnsignedInput();
  const signingContext = signingContextFor(input);
  const prepared = prepareProtectedInstallEvidenceCommit(input, signingContext);
  const signatureFile = signatureFor(prepared);
  return { input, signingContext, prepared, signatureFile };
}

function expectedFor(fixture: ReturnType<typeof validSignedFixture>) {
  const { input, prepared, signatureFile } = fixture;
  return {
    operationId: input.operationId,
    candidateSha: input.release.sourceSha,
    candidateImageDigest: input.release.imageId,
    rollbackSha: input.rollback.sourceSha,
    rollbackImageDigest: input.rollback.imageId,
    releaseManifestSha256: input.releaseManifestSha256,
    rollbackReleaseManifestSha256: input.rollback.releaseManifestSha256,
    productionTargetDescriptorSha256: input.target.descriptorSha256,
    releaseOperatorBundleSha256: input.release.operatorBundleSha256,
    installedOperatorBundleSha256: input.installed.operatorBundleSha256,
    databaseFingerprint: input.target.databaseFingerprint,
    backupRestoreEvidenceSha256: input.backupEvidence.evidenceSha256,
    producer: input.producer,
    hostLock: prepared.expectedHostLock,
    databaseSlot: prepared.expectedDatabaseSlot,
    signatureFile,
  };
}

test("assembles the exact complete protected-install evidence and verifies its signature binding", async () => {
  const fixture = validSignedFixture();
  const evidence = assembleProtectedInstallEvidence({
    ...fixture.input,
    signingContext: fixture.signingContext,
    signatureFile: fixture.signatureFile,
  });
  assert.equal(evidence.afterSchema, fixture.input.release.schema.max);
  assert.equal(evidence.installedMigrationSetSha256, fixture.input.release.migrationSetSha256);
  assert.equal(evidence.pendingReleasedMigrationCount, 0);
  assert.equal(evidence.hostLock.operationId, evidence.databaseSlot.operationId);
  assert.equal(evidence.hostLock.state, "installed-awaiting-gate6");
  assert.equal(evidence.databaseSlot.state, "installed-awaiting-gate6");
  assert.deepEqual(evidence.activatedServices, BASELINE_SERVICES);
  assert.deepEqual(Object.keys(evidence.producer).sort(), [
    "environment",
    "repository",
    "workflow",
    "workflowFileSha256",
    "workflowSha",
  ]);
  assert.equal(evidence.signatureSha256, sha256Canonical(fixture.signatureFile));
  assert(Object.isFrozen(evidence));

  const verified = verifyProtectedInstallEvidence(evidence, expectedFor(fixture));
  assert.deepEqual(verified, {
    ok: true,
    evidenceSha256: sha256Canonical(evidence),
    installedSchemaVersion: 36,
    installedMigrationSetSha256: fixture.input.release.migrationSetSha256,
  });

  const schema = JSON.parse(
    await readFile(
      new URL("../deploy/protected-install-evidence.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(evidence).sort());
  assert.deepEqual(Object.keys(schema.$defs.ownedLock.properties).sort(), [
    "operationId",
    "state",
    "version",
  ]);
  assert.deepEqual([...schema.properties.producer.required].sort(), [
    "environment",
    "repository",
    "workflow",
    "workflowFileSha256",
    "workflowSha",
  ]);
  assert.deepEqual(Object.keys(schema.properties.producer.properties).sort(), [
    "environment",
    "repository",
    "workflow",
    "workflowFileSha256",
    "workflowSha",
  ]);
});

test("rejects source, receipt, ordered-service, lease, producer, and secret-shaped mismatches", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    [
      "candidate image",
      (v) => {
        v.installed.imageDigest = image("wrong-candidate");
      },
      /candidate|image/i,
    ],
    [
      "rollback image",
      (v) => {
        v.rollbackReadiness.rollbackImageDigest = image("wrong-rollback");
      },
      /rollback/i,
    ],
    [
      "operator bundle",
      (v) => {
        v.installed.operatorBundleSha256 = digest("wrong-bundle");
      },
      /operator bundle/i,
    ],
    [
      "target descriptor",
      (v) => {
        v.installed.targetDescriptorSha256 = digest("wrong-target");
      },
      /target descriptor/i,
    ],
    [
      "database fingerprint",
      (v) => {
        v.installed.databaseFingerprint = image("wrong-db");
      },
      /database fingerprint/i,
    ],
    [
      "backup hash",
      (v) => {
        v.migrationReceipt.backupRestoreEvidenceSha256 = digest("wrong-backup");
      },
      /backup/i,
    ],
    [
      "after schema",
      (v) => {
        v.migrationReceipt.afterSchema = 35;
      },
      /schema/i,
    ],
    [
      "migration set",
      (v) => {
        v.migrationReceipt.installedMigrationSetSha256 = digest("wrong-set");
      },
      /migration/i,
    ],
    [
      "online algorithm",
      (v) => {
        v.onlineDdlReceipts[0].algorithm = "INSTANT";
      },
      /online DDL/i,
    ],
    [
      "pending migration",
      (v) => {
        v.migrationReceipt.pendingReleasedMigrationCount = 1;
      },
      /pending/i,
    ],
    [
      "grant operation",
      (v) => {
        v.grantEvidence.operationId = "another-install";
      },
      /grant|operation/i,
    ],
    [
      "service order",
      (v) => {
        v.serviceActivationJournal.entries.reverse();
      },
      /service/i,
    ],
    [
      "health",
      (v) => {
        v.healthEvidence.passed = false;
      },
      /health/i,
    ],
    [
      "watermark",
      (v) => {
        v.watermarkEvidence.passed = false;
      },
      /watermark/i,
    ],
    [
      "rollback readiness",
      (v) => {
        v.rollbackReadiness.ready = false;
      },
      /rollback/i,
    ],
    [
      "watchdog continuity",
      (v) => {
        v.watchdogJournal.continuous = false;
      },
      /watchdog/i,
    ],
    [
      "operation",
      (v) => {
        v.hostLock.operationId = "another-install";
      },
      /operation/i,
    ],
    [
      "lease",
      (v) => {
        v.finalLease.heartbeatAt = v.watchdogJournal.firstMutationAt;
      },
      /lease|heartbeat/i,
    ],
    [
      "producer secret",
      (v) => {
        v.producer.repository = "password=do-not-export";
      },
      /secret/i,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const value = validUnsignedInput() as any;
    mutate(value);
    assert.throws(
      () => prepareProtectedInstallEvidenceCommit(value, signingContextFor(value)),
      pattern,
      label,
    );
  }
});

test("rejects signature/core/digest and producer metadata substitution", () => {
  const fixture = validSignedFixture();
  assert.throws(
    () =>
      assembleProtectedInstallEvidence({
        ...fixture.input,
        signingContext: fixture.signingContext,
        signatureFile: { ...fixture.signatureFile, subjectSha256: digest("wrong-core") },
      }),
    /signature|subject|core/i,
  );
  const evidence = assembleProtectedInstallEvidence({
    ...fixture.input,
    signingContext: fixture.signingContext,
    signatureFile: fixture.signatureFile,
  });
  assert.throws(
    () =>
      verifyProtectedInstallEvidence(
        { ...evidence, signatureSha256: digest("wrong-signature-file") },
        expectedFor(fixture),
      ),
    /signature/i,
  );
  assert.throws(
    () =>
      verifyProtectedInstallEvidence(evidence, {
        ...expectedFor(fixture),
        producer: { ...fixture.input.producer, workflowSha: "d".repeat(40) },
      }),
    /producer/i,
  );
});

class MemoryFiles {
  files = new Map<string, { bytes: Buffer; mode: number; symlink?: boolean }>();
  directories = new Set<string>();
  events: string[] = [];

  async exists(path: string) {
    return this.files.has(path) || this.directories.has(path);
  }

  async assertPrivateDirectory(path: string) {
    if (!this.directories.has(path)) throw new Error("fixed input directory is missing");
    return { path, generation: 1 };
  }

  async ensureDirectory(path: string, mode: number) {
    this.events.push(`mkdir:${path}:${mode.toString(8)}`);
    this.directories.add(path);
  }

  async list(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
      .map((name) => name.slice(prefix.length))
      .sort();
  }

  async createOnce(path: string, bytes: Buffer, mode: number) {
    this.events.push(`create:${path}:${mode.toString(8)}`);
    if (this.files.has(path)) throw new Error("create-once conflict");
    this.files.set(path, { bytes: Buffer.from(bytes), mode });
  }

  async readStable(path: string) {
    this.events.push(`read:${path}`);
    const value = this.files.get(path);
    if (!value) throw new Error("prepared file missing");
    if (value.symlink) throw new Error("prepared file symlink is forbidden");
    if (value.mode !== 0o400) throw new Error("prepared file mode is invalid");
    return Buffer.from(value.bytes);
  }

  async fsyncDirectory(path: string) {
    this.events.push(`fsync-dir:${path}`);
  }

  async renameDirectory(from: string, to: string) {
    this.events.push(`rename:${from}:${to}`);
    if (this.directories.has(to)) throw new Error("archive conflict");
    this.directories.add(to);
    const prefix = `${from}/`;
    for (const [path, value] of [...this.files]) {
      if (path.startsWith(prefix)) {
        this.files.delete(path);
        this.files.set(`${to}/${path.slice(prefix.length)}`, value);
      }
    }
    this.directories.delete(from);
  }

  async removeIncompleteDirectory(path: string, names: string[]) {
    this.events.push(`remove-incomplete:${path}`);
    for (const name of names) this.files.delete(`${path}/${name}`);
    this.directories.delete(path);
  }
}

function commitPorts(options: { crashAfterSlot?: boolean } = {}) {
  const files = new MemoryFiles();
  const fixture = validSignedFixture();
  const state: any = {
    databaseSlot: { ...fixture.input.databaseSlot },
    hostLock: { ...fixture.input.hostLock },
    slotCalls: 0,
    hostCalls: 0,
  };
  return {
    fixture,
    files,
    state,
    ports: {
      files,
      async finalizeDatabaseSlot(binding: any) {
        state.slotCalls += 1;
        if (state.databaseSlot.state === "installing") {
          assert.equal(state.databaseSlot.version, binding.expectedCurrentVersion);
          state.databaseSlot = {
            operationId: binding.operationId,
            state: "installed-awaiting-gate6",
            version: binding.expectedNextVersion,
            protectedInstallEvidenceSha256: binding.protectedInstallEvidenceSha256,
            heartbeatAt: binding.heartbeatAt,
            expiresAt: binding.expiresAt,
          };
        }
        if (options.crashAfterSlot && state.slotCalls === 1)
          throw new Error("crash after slot CAS");
      },
      async finalizeHostLock(binding: any) {
        state.hostCalls += 1;
        if (state.hostLock.state === "installing") {
          assert.equal(state.hostLock.version, binding.expectedCurrentVersion);
          state.hostLock = {
            operationId: binding.operationId,
            state: "installed-awaiting-gate6",
            version: binding.expectedNextVersion,
            protectedInstallEvidenceSha256: binding.protectedInstallEvidenceSha256,
            heartbeatAt: binding.heartbeatAt,
            expiresAt: binding.expiresAt,
          };
        }
      },
      async readDatabaseSlot() {
        return clone(state.databaseSlot);
      },
      async readHostLock() {
        return clone(state.hostLock);
      },
    },
  };
}

test("durably prepares before CAS, reconciles a partial CAS without another signature, and exports fixed bytes", async () => {
  const context = commitPorts({ crashAfterSlot: true });
  let signerCalls = 0;
  const signatureFile = (() => {
    signerCalls += 1;
    return signatureFor(context.fixture.prepared);
  })();
  await assert.rejects(
    () => commitProtectedInstallEvidence(context.fixture.prepared, signatureFile, context.ports),
    /crash after slot CAS/,
  );
  assert.equal(signerCalls, 1);
  assert.equal(context.state.databaseSlot.state, "installed-awaiting-gate6");
  assert.equal(context.state.hostLock.state, "installing");
  const preparedCommitPath = `${PROTECTED_INSTALL_PATHS.preparedRoot}/${context.fixture.input.operationId}/prepared-commit.json`;
  assert(context.files.files.has(preparedCommitPath));
  assert.equal(context.state.hostCalls, 0);

  const result = await commitProtectedInstallEvidence(
    context.fixture.prepared,
    signatureFile,
    context.ports,
  );
  assert.equal(signerCalls, 1);
  assert.equal(context.state.hostLock.protectedInstallEvidenceSha256, result.evidenceSha256);
  assert.equal(context.state.databaseSlot.protectedInstallEvidenceSha256, result.evidenceSha256);
  assert.equal(
    context.files.files.get(PROTECTED_INSTALL_PATHS.evidenceExport)?.bytes.toString("utf8"),
    canonicalJson(result.evidence),
  );
  assert.equal(
    context.files.files.get(PROTECTED_INSTALL_PATHS.signatureExport)?.bytes.toString("utf8"),
    canonicalJson(signatureFile),
  );
  assert(
    context.files.events.indexOf(`create:${preparedCommitPath}:400`) <
      context.files.events.findIndex((event) => event.startsWith("rename:")),
  );
});

test("refuses unsafe incomplete, replaced, symlinked, conflicting-signature, or prediction-tampered prepared commits before CAS", async () => {
  {
    const context = commitPorts();
    const dir = `${PROTECTED_INSTALL_PATHS.preparedRoot}/${context.fixture.input.operationId}`;
    context.files.directories.add(dir);
    context.files.files.set(`${dir}/prepared-commit.json`, {
      bytes: Buffer.from(canonicalJson(context.fixture.prepared.core)),
      mode: 0o400,
    });
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /incomplete|prepared/i,
    );
    assert.equal(context.state.slotCalls, 0);
  }
  {
    const context = commitPorts({ crashAfterSlot: true });
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /crash/,
    );
    const corePath = `${PROTECTED_INSTALL_PATHS.preparedRoot}/${context.fixture.input.operationId}/evidence-core.json`;
    context.files.files.get(corePath)!.bytes = Buffer.from("{}", "utf8");
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /hash|prepared|core/i,
    );
  }
  {
    const context = commitPorts({ crashAfterSlot: true });
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /crash/,
    );
    const signaturePath = `${PROTECTED_INSTALL_PATHS.preparedRoot}/${context.fixture.input.operationId}/protected-install-signature.json`;
    context.files.files.get(signaturePath)!.symlink = true;
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /symlink/i,
    );
  }
  {
    const context = commitPorts({ crashAfterSlot: true });
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          context.fixture.signatureFile,
          context.ports,
        ),
      /crash/,
    );
    await assert.rejects(
      () =>
        commitProtectedInstallEvidence(
          context.fixture.prepared,
          {
            ...context.fixture.signatureFile,
            signatureBase64: Buffer.from("a-second-kms-result").toString("base64"),
          },
          context.ports,
        ),
      /signature|prepared/i,
    );
  }
  {
    const context = commitPorts();
    const tampered = clone(context.fixture.prepared) as any;
    tampered.expectedHostLock.version += 1;
    await assert.rejects(
      () => commitProtectedInstallEvidence(tampered, context.fixture.signatureFile, context.ports),
      /prediction|host lock|prepared/i,
    );
    assert.equal(context.state.slotCalls, 0);
  }
});

test("recovers a byte-identical signature after a crash midway through prepared-file creation only while both states remain installing", async () => {
  const context = commitPorts();
  let signerCalls = 0;
  const signatureFile = (() => {
    signerCalls += 1;
    return signatureFor(context.fixture.prepared);
  })();
  const createOnce = context.files.createOnce.bind(context.files);
  let preparedCreates = 0;
  let injectCrash = true;
  context.files.createOnce = async (path: string, bytes: Buffer, mode: number) => {
    await createOnce(path, bytes, mode);
    if (path.includes("/prepared/") && ++preparedCreates === 2 && injectCrash) {
      injectCrash = false;
      throw new Error("crash midway through prepared files");
    }
  };
  await assert.rejects(
    () => commitProtectedInstallEvidence(context.fixture.prepared, signatureFile, context.ports),
    /crash midway/,
  );
  assert.equal(context.state.slotCalls, 0);
  assert.equal(context.state.hostCalls, 0);

  const result = await commitProtectedInstallEvidence(
    context.fixture.prepared,
    signatureFile,
    context.ports,
  );
  assert.equal(signerCalls, 1);
  assert.equal(context.state.databaseSlot.protectedInstallEvidenceSha256, result.evidenceSha256);
  assert(context.files.events.some((event) => event.startsWith("remove-incomplete:")));
});

function cliInputBundle(input: ReturnType<typeof validUnsignedInput>) {
  const installContext = {
    schemaVersion: input.schemaVersion,
    releaseEnvironment: input.releaseEnvironment,
    operationId: input.operationId,
    releaseManifestSha256: input.releaseManifestSha256,
    release: input.release,
    rollback: input.rollback,
    target: input.target,
    installed: input.installed,
    hostLock: input.hostLock,
    databaseSlot: input.databaseSlot,
    finalLease: input.finalLease,
    issuedAt: input.issuedAt,
  };
  return new Map<string, unknown>([
    ["verified-install-context.json", installContext],
    ["verified-producer-context.json", input.producer],
    ["verified-backup-evidence-summary.json", input.backupEvidence],
    ["verified-migration-receipt.json", input.migrationReceipt],
    [
      "verified-online-ddl-receipts.json",
      {
        classifiedPendingAlters: input.classifiedPendingAlters,
        onlineDdlReceipts: input.onlineDdlReceipts,
      },
    ],
    ["verified-grant-evidence.json", input.grantEvidence],
    ["verified-service-activation-journal.json", input.serviceActivationJournal],
    ["verified-watchdog-journal.json", input.watchdogJournal],
    ["verified-health-evidence.json", input.healthEvidence],
    ["verified-watermark-evidence.json", input.watermarkEvidence],
    ["verified-rollback-readiness.json", input.rollbackReadiness],
    ["verified-signing-context.json", signingContextFor(input)],
  ]);
}

function fixedCliContext(options: { crashAfterDatabase?: boolean } = {}) {
  const input = validUnsignedInput();
  const files = new MemoryFiles();
  files.directories.add(PROTECTED_INSTALL_INPUT_FILES.root);
  for (const [name, value] of cliInputBundle(input)) {
    files.files.set(`${PROTECTED_INSTALL_INPUT_FILES.root}/${name}`, {
      bytes: Buffer.from(canonicalJson(value), "utf8"),
      mode: 0o400,
    });
  }
  const state: any = {
    databaseSlot: {
      ...input.databaseSlot,
      protectedInstallEvidenceSha256: digest("install-intent"),
    },
    hostLock: { ...input.hostLock, protectedInstallEvidenceSha256: digest("install-intent") },
    previewDatabaseCalls: 0,
    previewHostCalls: 0,
    databaseFinalizeCalls: 0,
    hostFinalizeCalls: 0,
    signCalls: 0,
    checkpointCrashInjected: false,
    previewDatabaseIdentity: null,
    previewHostIdentity: null,
    signingContext: null,
  };
  const testPorts: any = {
    files,
    async previewDatabaseSlot(identity: any) {
      state.previewDatabaseCalls += 1;
      state.previewDatabaseIdentity = clone(identity);
      return {
        current: {
          operationId: input.operationId,
          state: "installing",
          version: input.databaseSlot.version,
        },
        next: {
          operationId: input.operationId,
          state: "installed-awaiting-gate6",
          version: input.databaseSlot.version + 1,
        },
      };
    },
    async previewHostLock(identity: any) {
      state.previewHostCalls += 1;
      state.previewHostIdentity = clone(identity);
      return {
        current: {
          operationId: input.operationId,
          state: "installing",
          version: input.hostLock.version,
        },
        next: {
          operationId: input.operationId,
          state: "installed-awaiting-gate6",
          version: input.hostLock.version + 1,
        },
      };
    },
    async sign(request: any, signingContext: any) {
      state.signCalls += 1;
      state.signingContext = clone(signingContext);
      files.events.push("kms-sign");
      assert.equal(
        request.subjectSha256,
        prepareProtectedInstallEvidenceCommit(input, signingContextFor(input)).signatureRequest
          .subjectSha256,
      );
      return Buffer.from("fixed zero-argument KMS result").toString("base64");
    },
    async finalizeDatabaseSlot(binding: any) {
      state.databaseFinalizeCalls += 1;
      if (state.databaseSlot.state === "installing") {
        state.databaseSlot = {
          operationId: binding.operationId,
          state: "installed-awaiting-gate6",
          version: binding.expectedNextVersion,
          protectedInstallEvidenceSha256: binding.protectedInstallEvidenceSha256,
          heartbeatAt: binding.heartbeatAt,
          expiresAt: binding.expiresAt,
        };
      }
    },
    async finalizeHostLock(binding: any) {
      state.hostFinalizeCalls += 1;
      if (state.hostLock.state === "installing") {
        state.hostLock = {
          operationId: binding.operationId,
          state: "installed-awaiting-gate6",
          version: binding.expectedNextVersion,
          protectedInstallEvidenceSha256: binding.protectedInstallEvidenceSha256,
          heartbeatAt: binding.heartbeatAt,
          expiresAt: binding.expiresAt,
        };
      }
    },
    async readDatabaseSlot() {
      return clone(state.databaseSlot);
    },
    async readHostLock() {
      return clone(state.hostLock);
    },
    async checkpoint(name: string) {
      if (
        options.crashAfterDatabase &&
        name === "database-slot-committed" &&
        !state.checkpointCrashInjected
      ) {
        state.checkpointCrashInjected = true;
        throw new Error("CLI crash after database CAS");
      }
    },
  };
  return { input, files, state, testPorts };
}

test("zero-argument fixed-root CLI signs once, uses preview/CAS ports, and recovers committed bytes without KMS", async () => {
  const context = fixedCliContext();
  const first = await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  assert.equal(first.ok, true);
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
  assert.deepEqual(context.state.previewDatabaseIdentity, {
    operationId: context.input.operationId,
    releaseSha: context.input.release.sourceSha,
    targetDescriptorSha256: context.input.target.descriptorSha256,
    operatorBundleSha256: context.input.installed.operatorBundleSha256,
    installedMigrationSetSha256: context.input.installed.migrationSetSha256,
    installedSchemaVersion: context.input.installed.schemaVersion,
  });
  assert.deepEqual(context.state.previewHostIdentity, {
    operationId: context.input.operationId,
    releaseSha: context.input.release.sourceSha,
    targetDescriptorSha256: context.input.target.descriptorSha256,
    operatorBundleSha256: context.input.installed.operatorBundleSha256,
  });
  assert.deepEqual(
    context.state.signingContext,
    cliInputBundle(context.input).get("verified-signing-context.json"),
  );
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  const intentPath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signingIntentFile}`;
  assert(context.files.files.has(intentPath));
  assert.equal(context.files.files.get(intentPath)?.mode, 0o400);
  assert.deepEqual(
    JSON.parse(context.files.files.get(intentPath)!.bytes.toString("utf8")),
    prepareProtectedInstallEvidenceCommit(context.input, signingContextFor(context.input))
      .signatureRequest,
  );
  assert(context.files.files.has(signaturePath));
  assert.equal(context.files.files.get(signaturePath)?.mode, 0o400);
  assert(
    context.files.events.indexOf(`create:${intentPath}:400`) <
      context.files.events.indexOf("kms-sign"),
  );
  assert(
    context.files.events.indexOf(`fsync-dir:${PROTECTED_INSTALL_INPUT_FILES.root}`) <
      context.files.events.indexOf("kms-sign"),
  );
  assert(
    context.files.events.indexOf("kms-sign") <
      context.files.events.indexOf(`create:${signaturePath}:400`),
  );
  assert.deepEqual(await context.files.list(PROTECTED_INSTALL_PATHS.exportRoot), [
    "protected-install-evidence.json",
    "protected-install-signature.json",
  ]);

  context.testPorts.sign = async () => {
    throw new Error("KMS must not be called during committed recovery");
  };
  const recovered = await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  assert.deepEqual(recovered, first);
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
});

test("fixed CLI contract exposes only fixed roots and the programmatic watchdog/host-lock adapters", async () => {
  assert.deepEqual(PROTECTED_INSTALL_INPUT_FILES.required, [
    "verified-install-context.json",
    "verified-producer-context.json",
    "verified-backup-evidence-summary.json",
    "verified-migration-receipt.json",
    "verified-online-ddl-receipts.json",
    "verified-grant-evidence.json",
    "verified-service-activation-journal.json",
    "verified-watchdog-journal.json",
    "verified-health-evidence.json",
    "verified-watermark-evidence.json",
    "verified-rollback-readiness.json",
    "verified-signing-context.json",
  ]);
  const evidenceSource = await readFile(
    new URL("../scripts/protected-install-evidence.mjs", import.meta.url),
    "utf8",
  );
  const watchdogSource = await readFile(
    new URL("../scripts/protected-install-watchdog.mjs", import.meta.url),
    "utf8",
  );
  assert.match(evidenceSource, /\/usr\/local\/libexec\/spx-kms-envelope/);
  assert.match(evidenceSource, /\/run\/credentials\/spx-protected-install-evidence-kms\.json/);
  assert.match(evidenceSource, /previewPreparedGate6SlotWithMysqlClient/);
  assert.match(evidenceSource, /readPreparedGate6SlotWithMysqlClient/);
  assert.match(evidenceSource, /commitPreparedGate6SlotWithMysqlClient/);
  assert.match(evidenceSource, /previewProductionInstallHostLockCommit/);
  assert.doesNotMatch(evidenceSource, /requires-fixed-trusted-context/);
  assert.match(watchdogSource, /export function previewPreparedGate6SlotWithMysqlClient/);
  assert.match(watchdogSource, /export function readPreparedGate6SlotWithMysqlClient/);
  assert.match(watchdogSource, /export function commitPreparedGate6SlotWithMysqlClient/);
});

test("fixed-root CLI rejects malformed signing context before preview or KMS", async () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    [
      "extra field",
      (value) => {
        value.untrustedPath = "/tmp/kms";
      },
      /canonical fields|signing context/i,
    ],
    [
      "version",
      (value) => {
        value.schemaVersion = 2;
      },
      /version|signing context/i,
    ],
    [
      "malformed hash",
      (value) => {
        value.kmsExecutableSha256 = "a";
      },
      /hash|executable/i,
    ],
    [
      "zero hash",
      (value) => {
        value.kmsCapabilitySha256 = "0".repeat(64);
      },
      /hash|capability/i,
    ],
    [
      "invalid key",
      (value) => {
        value.evidenceSigningKeyId = "invalid/key";
      },
      /key|signing context/i,
    ],
    [
      "predated signature",
      (value) => {
        value.signedAt = "2026-07-16T01:09:59.000Z";
      },
      /predates|signing context/i,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const context = fixedCliContext();
    const path = `${PROTECTED_INSTALL_INPUT_FILES.root}/verified-signing-context.json`;
    const file = context.files.files.get(path)!;
    const value = JSON.parse(file.bytes.toString("utf8"));
    mutate(value);
    file.bytes = Buffer.from(canonicalJson(value), "utf8");
    await assert.rejects(
      () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
      expected,
      label,
    );
    assert.equal(context.state.previewDatabaseCalls, 0, label);
    assert.equal(context.state.previewHostCalls, 0, label);
    assert.equal(context.state.signCalls, 0, label);
  }
});

test("fixed-root CLI sources the signing key from verified signing context, not producer", async () => {
  const context = fixedCliContext();
  const signingPath = `${PROTECTED_INSTALL_INPUT_FILES.root}/verified-signing-context.json`;
  const signingFile = context.files.files.get(signingPath)!;
  const signingContext = JSON.parse(signingFile.bytes.toString("utf8"));
  signingContext.evidenceSigningKeyId = "spx-production-install-evidence-v2";
  signingFile.bytes = Buffer.from(canonicalJson(signingContext), "utf8");
  await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  const signature = JSON.parse(context.files.files.get(signaturePath)!.bytes.toString("utf8"));
  assert.equal(signature.keyId, signingContext.evidenceSigningKeyId);
  assert.equal(
    context.state.signingContext.evidenceSigningKeyId,
    signingContext.evidenceSigningKeyId,
  );
  assert.deepEqual(Object.keys(context.input.producer).sort(), [
    "environment",
    "repository",
    "workflow",
    "workflowFileSha256",
    "workflowSha",
  ]);
});

test("fixed-root CLI recovers a complete archive when the context signature is absent", async () => {
  const context = fixedCliContext();
  const first = await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  const expectedSignature = Buffer.from(context.files.files.get(signaturePath)!.bytes);
  context.files.files.delete(signaturePath);
  context.testPorts.sign = async () => {
    throw new Error("KMS must not be called when the complete archive is valid");
  };
  context.testPorts.previewDatabaseSlot = async () => {
    throw new Error("database preview must not run for a complete archive");
  };
  context.testPorts.previewHostLock = async () => {
    throw new Error("host preview must not run for a complete archive");
  };

  const recovered = await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  assert.deepEqual(recovered, first);
  assert(context.files.files.get(signaturePath)!.bytes.equals(expectedSignature));
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
});

test("fixed-root CLI fails closed on simultaneous prepared and committed archives", async () => {
  const context = fixedCliContext();
  await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  context.files.directories.add(
    `${PROTECTED_INSTALL_PATHS.preparedRoot}/${context.input.operationId}`,
  );
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /prepared.*committed|archive.*conflict/i,
  );
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
});

test("fixed-root CLI fails closed on an incomplete committed archive", async () => {
  const context = fixedCliContext();
  await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  const committedDirectory = `${PROTECTED_INSTALL_PATHS.committedRoot}/${context.input.operationId}`;
  context.files.files.delete(`${committedDirectory}/evidence-core.json`);
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /committed archive.*incomplete|incomplete.*committed/i,
  );
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
});

test("orphan durable signing intent is indeterminate and never authorizes another KMS call or finalize", async () => {
  const context = fixedCliContext();
  context.testPorts.checkpoint = async (name: string) => {
    if (name === "signing-intent-durable") {
      throw new Error("crash after durable signing intent");
    }
  };
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /crash after durable signing intent/,
  );
  const intentPath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signingIntentFile}`;
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  assert(context.files.files.has(intentPath));
  assert.equal(context.files.files.get(intentPath)?.mode, 0o400);
  assert.equal(context.files.files.has(signaturePath), false);
  assert.equal(context.state.signCalls, 0);
  assert.equal(context.state.databaseFinalizeCalls, 0);
  assert.equal(context.state.hostFinalizeCalls, 0);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);

  context.testPorts.checkpoint = async () => {};
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /signing intent.*indeterminate|indeterminate.*signature/i,
  );
  assert.equal(context.state.signCalls, 0);
  assert.equal(context.state.databaseFinalizeCalls, 0);
  assert.equal(context.state.hostFinalizeCalls, 0);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
});

test("KMS return followed by signature-persist failure never permits a second KMS result", async () => {
  const context = fixedCliContext();
  const createOnce = context.files.createOnce.bind(context.files);
  const intentPath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signingIntentFile}`;
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  let failSignaturePersist = true;
  context.files.createOnce = async (path: string, bytes: Buffer, mode: number) => {
    if (path === signaturePath && failSignaturePersist) {
      failSignaturePersist = false;
      throw new Error("crash after KMS return before signature persistence");
    }
    await createOnce(path, bytes, mode);
  };
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /crash after KMS return before signature persistence/,
  );
  assert(context.files.files.has(intentPath));
  assert.equal(context.files.files.has(signaturePath), false);
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 0);
  assert.equal(context.state.hostFinalizeCalls, 0);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);

  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /signing intent.*indeterminate|indeterminate.*signature/i,
  );
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 0);
  assert.equal(context.state.hostFinalizeCalls, 0);
  assert.equal(context.state.previewDatabaseCalls, 1);
  assert.equal(context.state.previewHostCalls, 1);
});

test("fixed context rejects a signature without its exact signing-intent record", async () => {
  const context = fixedCliContext();
  await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  const intentPath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signingIntentFile}`;
  context.files.files.delete(intentPath);
  await assert.rejects(
    () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
    /file set|context|missing/i,
  );
  assert.equal(context.state.signCalls, 1);
  assert.equal(context.state.databaseFinalizeCalls, 1);
  assert.equal(context.state.hostFinalizeCalls, 1);
});

test("fixed-root CLI accepts exact JSON KMS output and a matching create-once race", async () => {
  const context = fixedCliContext();
  const base64 = Buffer.from("fixed JSON KMS signature result").toString("base64");
  context.testPorts.sign = async () => {
    context.state.signCalls += 1;
    return canonicalJson({ signatureBase64: base64 });
  };
  const createOnce = context.files.createOnce.bind(context.files);
  const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
  let raced = false;
  context.files.createOnce = async (path: string, bytes: Buffer, mode: number) => {
    if (path === signaturePath && !raced) {
      raced = true;
      context.files.files.set(path, { bytes: Buffer.from(bytes), mode });
      throw new Error("simulated matching create-once race");
    }
    await createOnce(path, bytes, mode);
  };
  const result = await runProtectedInstallEvidenceCli({ testPorts: context.testPorts });
  assert.equal(result.ok, true);
  assert.equal(raced, true);
  assert.equal(context.state.signCalls, 1);
  const signature = JSON.parse(context.files.files.get(signaturePath)!.bytes.toString("utf8"));
  assert.equal(signature.signatureBase64, base64);
});

test("fixed-root CLI rejects arguments and unsafe context inputs before preview or CAS", async () => {
  const modulePath = fileURLToPath(
    new URL("../scripts/protected-install-evidence.mjs", import.meta.url),
  );
  const invoked = spawnSync(process.execPath, [modulePath, "--context=/tmp/forbidden"], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  assert.notEqual(invoked.status, 0);
  assert.match(invoked.stderr, /protected-install-evidence-failed/i);
  assert.doesNotMatch(invoked.stderr, /\/tmp\/forbidden/);

  const cases: Array<[string, (context: ReturnType<typeof fixedCliContext>) => void, RegExp]> = [
    [
      "missing",
      (c) => {
        c.files.files.delete(`${PROTECTED_INSTALL_INPUT_FILES.root}/verified-health-evidence.json`);
      },
      /missing|file set|context/i,
    ],
    [
      "extra",
      (c) => {
        c.files.files.set(`${PROTECTED_INSTALL_INPUT_FILES.root}/unexpected.json`, {
          bytes: Buffer.from("{}"),
          mode: 0o400,
        });
      },
      /extra|file set|context/i,
    ],
    [
      "symlink",
      (c) => {
        c.files.files.get(
          `${PROTECTED_INSTALL_INPUT_FILES.root}/verified-health-evidence.json`,
        )!.symlink = true;
      },
      /symlink/i,
    ],
    [
      "mode",
      (c) => {
        c.files.files.get(
          `${PROTECTED_INSTALL_INPUT_FILES.root}/verified-health-evidence.json`,
        )!.mode = 0o600;
      },
      /mode/i,
    ],
    [
      "noncanonical",
      (c) => {
        const file = c.files.files.get(
          `${PROTECTED_INSTALL_INPUT_FILES.root}/verified-health-evidence.json`,
        )!;
        file.bytes = Buffer.from(`${file.bytes.toString("utf8")}\n`, "utf8");
      },
      /canonical/i,
    ],
    [
      "directory metadata",
      (c) => {
        c.files.assertPrivateDirectory = async () => {
          throw new Error("fixed input directory metadata or mode is invalid");
        };
      },
      /directory|metadata|mode/i,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const context = fixedCliContext();
    mutate(context);
    await assert.rejects(
      () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
      pattern,
      label,
    );
    assert.equal(context.state.previewDatabaseCalls, 0, label);
    assert.equal(context.state.previewHostCalls, 0, label);
  }
});

test("fixed-root CLI rejects replaced context and a conflicting durable signature during partial-CAS recovery", async () => {
  {
    const context = fixedCliContext();
    let snapshots = 0;
    context.files.assertPrivateDirectory = async (path: string) => ({
      path,
      generation: ++snapshots,
    });
    await assert.rejects(
      () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
      /changed|replaced|directory/i,
    );
    assert.equal(context.state.previewDatabaseCalls, 0);
  }
  {
    const context = fixedCliContext({ crashAfterDatabase: true });
    await assert.rejects(
      () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
      /CLI crash after database CAS/,
    );
    assert.equal(context.state.signCalls, 1);
    const signaturePath = `${PROTECTED_INSTALL_INPUT_FILES.root}/${PROTECTED_INSTALL_INPUT_FILES.signatureFile}`;
    const signature = JSON.parse(context.files.files.get(signaturePath)!.bytes.toString("utf8"));
    signature.signatureBase64 = Buffer.from("conflicting second KMS result").toString("base64");
    context.files.files.get(signaturePath)!.bytes = Buffer.from(canonicalJson(signature), "utf8");
    await assert.rejects(
      () => runProtectedInstallEvidenceCli({ testPorts: context.testPorts }),
      /signature|prepared|conflict/i,
    );
    assert.equal(context.state.signCalls, 1);
    assert.equal(context.state.hostLock.state, "installing");
  }
});
