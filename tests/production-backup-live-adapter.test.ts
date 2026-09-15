import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ACTIVE_OPERATION_FILE,
  BACKUP_CONTEXT_FILE,
  BACKUP_OPERATIONS_ROOT,
  BACKUP_RUNTIME_ROOT,
  DOCKER_EXECUTABLE,
  ISOLATED_CLIENT_FILE,
  ISOLATED_PASSWORD_FILE,
  KMS_CAPABILITY_FILE,
  KMS_EXECUTABLE,
  MYSQLDUMP_EXECUTABLE,
  MYSQL_EXECUTABLE,
  SOURCE_CREDENTIAL_FILE,
  createProductionBackupLiveAdapter,
  validateVerifiedBackupContext,
} from "../scripts/lib/production-backup-live-adapter.mjs";

const H = (character: string) => character.repeat(64);
const fixedNow = "2026-07-16T01:02:03.000Z";

const validContext = {
  schemaVersion: 1,
  operationId: "12345678-1234-4123-8123-123456789abc",
  candidateSha: "a".repeat(40),
  releaseManifestSha256: H("b"),
  targetDescriptorSha256: H("c"),
  databaseFingerprint: `sha256:${H("d")}`,
  createdAt: "2026-07-16T00:55:00.000Z",
  limits: {
    maximumAgeMinutes: 60,
    maximumRpoMinutes: 15,
    maximumRtoMinutes: 30,
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
} as const;

type Call = { kind: string; [key: string]: unknown };

async function defaultRun(calls: Call[], spec: { command: string; argv: string[] }) {
  calls.push({ kind: "run", spec });
  const sql = spec.argv.find((value) => value.startsWith("--execute=")) ?? "";
  if (spec.command === MYSQL_EXECUTABLE && sql.includes("gate6_environment_slots")) {
    return { stdout: "absent\n" };
  }
  if (spec.command === MYSQL_EXECUTABLE && sql.includes("@@server_uuid")) {
    return { stdout: "550e8400-e29b-41d4-a716-446655440000\t8.4.0\tSPX\n" };
  }
  if (sql.includes("REFERENTIAL_CONSTRAINTS")) return { stdout: "fk-shape\n" };
  if (sql.includes("COLUMNS")) return { stdout: "schema-shape\n" };
  if (sql.includes("TRIGGERS")) return { stdout: "runtime-shape\n" };
  if (spec.command === DOCKER_EXECUTABLE && spec.argv.includes("exec")) {
    if (sql.includes("TABLE_ROWS")) return { stdout: "bookings\t12\nusers\t4\n" };
    if (sql.includes("DATABASE()")) return { stdout: "isolated-server\tSPX\n" };
  }
  if (spec.command === KMS_EXECUTABLE && spec.argv[0] === "sign") {
    return { stdout: `${Buffer.from("kms-signature-value").toString("base64")}\n` };
  }
  return { stdout: "" };
}

function makePort(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const encryptedBackupPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`;
  const encryptionMetadataPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`;
  const port = {
    calls,
    now() {
      return new Date(fixedNow);
    },
    randomBytes(size: number) {
      calls.push({ kind: "randomBytes", size });
      return Buffer.alloc(size, 0x41);
    },
    async assertSecureDirectory(spec: unknown) {
      calls.push({ kind: "assertSecureDirectory", spec });
    },
    async assertSecureFile(spec: unknown) {
      calls.push({ kind: "assertSecureFile", spec });
    },
    async ensurePrivateDirectory(spec: unknown) {
      calls.push({ kind: "ensurePrivateDirectory", spec });
    },
    async listSecureDirectory(path: string) {
      calls.push({ kind: "listSecureDirectory", path });
      return [];
    },
    async readSecureJson(spec: { path: string }) {
      calls.push({ kind: "readSecureJson", spec });
      return null;
    },
    async writeExclusive(spec: unknown) {
      calls.push({ kind: "writeExclusive", spec });
    },
    async removeFile(spec: unknown) {
      calls.push({ kind: "removeFile", spec });
    },
    async hashFile(path: string) {
      calls.push({ kind: "hashFile", path });
      if (path === encryptedBackupPath) return H("c");
      if (path === encryptionMetadataPath) return H("d");
      return H("e");
    },
    async inspectHostLock() {
      calls.push({ kind: "inspectHostLock" });
      return null;
    },
    async run(spec: { command: string; argv: string[] }) {
      return defaultRun(calls, spec);
    },
    async pipeline(spec: unknown) {
      calls.push({ kind: "pipeline", spec });
      return { sourceExitCode: 0, sinkExitCode: 0 };
    },
    ...overrides,
  };
  return port;
}

async function prepareRetainedBackupForSigning(
  adapter: ReturnType<typeof createProductionBackupLiveAdapter>,
) {
  await adapter.assertMutationQuiescent("before-capture");
  const fingerprint = await adapter.readProductionFingerprint();
  const backup = await adapter.createEncryptedBackup({
    context: validContext,
    productionFingerprint: fingerprint,
  });
  await adapter.startIsolatedRestore({ backupSha256: backup.backupSha256 });
  const restore = await adapter.restoreBackup({ backupSha256: backup.backupSha256 });
  await adapter.verifyFixedInvariants({ restore });
  await adapter.captureSanitizedRowCountDigest({ restore });
  await adapter.destroyIsolatedRestore();
  await adapter.assertMutationQuiescent("after-teardown");
  return backup;
}

test("context, invariant, and Compose contracts are exact and isolated", async () => {
  assert.deepEqual(validateVerifiedBackupContext(validContext), validContext);
  assert.throws(
    () => validateVerifiedBackupContext({ ...validContext, database: "SPX" }),
    /context.*invalid/i,
  );
  assert.equal(
    BACKUP_CONTEXT_FILE,
    "/var/lib/spx-production-backup/context/verified-backup-context.json",
  );
  assert.equal(BACKUP_RUNTIME_ROOT, "/var/lib/spx-production-backup/runtime");

  const invariants = JSON.parse(await readFile("deploy/production-backup-invariants.json", "utf8"));
  const serializedInvariants = JSON.stringify(invariants);
  assert.deepEqual(
    invariants.invariants.map((entry: { id: string }) => entry.id),
    ["schema-shape", "foreign-key-shape", "runtime-object-shape"],
  );
  assert.ok(
    invariants.invariants.every(
      (entry: { expectation: string }) =>
        entry.expectation === "source-before-after-and-isolated-digests-identical",
    ),
  );
  assert.doesNotMatch(serializedInvariants, /SELECT|FROM|TABLE_NAME|COLUMN_NAME/i);

  const compose = await readFile("deploy/production-backup-isolated-compose.yml", "utf8");
  assert.match(compose, /internal:\s*true/);
  assert.match(compose, /isolated-mysql/);
  assert.match(compose, /isolated-root-password/);
  assert.match(compose, /isolated-client/);
  assert.doesNotMatch(
    compose,
    /ports:|network_mode:\s*host|spx-production-backup-source|provider/i,
  );
  assert.doesNotMatch(compose, /\$\{[^}]*PASSWORD/i);
});

test("live adapter fixes executable, credential, snapshot, KMS, and isolation boundaries", async () => {
  const port = makePort();
  const adapter = createProductionBackupLiveAdapter(validContext, port);

  await adapter.recoverAbandonedOperation();
  const before = await adapter.assertMutationQuiescent("before-capture");
  const fingerprint = await adapter.readProductionFingerprint();
  const backup = await adapter.createEncryptedBackup({
    context: validContext,
    productionFingerprint: fingerprint,
  });
  const boundary = await adapter.startIsolatedRestore({ backupSha256: backup.backupSha256 });
  const restore = await adapter.restoreBackup({ backupSha256: backup.backupSha256 });
  const invariant = await adapter.verifyFixedInvariants({ restore });
  const counts = await adapter.captureSanitizedRowCountDigest({ restore });
  const teardown = await adapter.destroyIsolatedRestore();
  const after = await adapter.assertMutationQuiescent("after-teardown");
  const signature = await adapter.signEvidenceCore({
    schemaVersion: 1,
    operationId: validContext.operationId,
    backupSha256: backup.backupSha256,
    encryptionMetadataSha256: backup.encryptionMetadataSha256,
  });

  assert.equal(before.hostLockState, "absent");
  assert.equal(before.gate6DatabaseSlotState, "absent");
  assert.equal(after.hostLockState, "absent");
  assert.equal(fingerprint.databaseFingerprint, validContext.databaseFingerprint);
  assert.deepEqual(backup, {
    backupSha256: H("c"),
    encryptionMetadataSha256: H("d"),
    createdAt: fixedNow,
    encrypted: true,
    beforeDdl: true,
    databaseFingerprint: validContext.databaseFingerprint,
  });
  assert.deepEqual(boundary, {
    environment: "isolated",
    productionRoutesPresent: false,
    providerCredentialsPresent: false,
    backgroundServicesPresent: false,
    sharedWritableVolumesPresent: false,
  });
  assert.match(restore.databaseFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(restore.databaseFingerprint, validContext.databaseFingerprint);
  assert.equal(
    invariant.invariantDefinitionsSha256,
    validContext.implementationSha256.invariantDefinitionsSha256,
  );
  assert.match(invariant.invariantResultsSha256, /^[0-9a-f]{64}$/);
  assert.match(counts.rowCountDigestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(teardown, { teardownProven: true, destroyedAt: fixedNow });
  assert.deepEqual(
    {
      schemaVersion: signature.schemaVersion,
      algorithm: signature.algorithm,
      keyId: signature.keyId,
    },
    { schemaVersion: 1, algorithm: "kms-sha256", keyId: validContext.evidenceSigningKeyId },
  );

  const secureFiles = port.calls
    .filter((call) => call.kind === "assertSecureFile")
    .map((call) => call.spec as { path: string; sha256: string; mode?: number });
  assert.ok(
    secureFiles.some((entry) => entry.path === SOURCE_CREDENTIAL_FILE && entry.mode === 0o400),
  );
  assert.ok(
    secureFiles.some((entry) => entry.path === KMS_CAPABILITY_FILE && entry.mode === 0o400),
  );
  assert.ok(
    secureFiles.some(
      (entry) =>
        entry.path === MYSQLDUMP_EXECUTABLE &&
        entry.sha256 === validContext.executableSha256.mysqldump,
    ),
  );
  assert.ok(
    secureFiles.some(
      (entry) =>
        entry.path === MYSQL_EXECUTABLE && entry.sha256 === validContext.executableSha256.mysql,
    ),
  );
  assert.ok(
    secureFiles.some(
      (entry) =>
        entry.path === DOCKER_EXECUTABLE && entry.sha256 === validContext.executableSha256.docker,
    ),
  );
  assert.ok(
    secureFiles.some(
      (entry) =>
        entry.path === KMS_EXECUTABLE && entry.sha256 === validContext.executableSha256.kmsEnvelope,
    ),
  );
  for (const executable of [
    MYSQLDUMP_EXECUTABLE,
    MYSQL_EXECUTABLE,
    DOCKER_EXECUTABLE,
    KMS_EXECUTABLE,
  ]) {
    const spec = secureFiles.find((entry) => entry.path === executable) as
      | { maxBytes?: number }
      | undefined;
    assert.ok((spec?.maxBytes ?? 0) >= 64 * 1024 * 1024);
  }

  const queryRuns = port.calls
    .filter(
      (call) =>
        call.kind === "run" &&
        ((call.spec as { command?: string }).command === MYSQL_EXECUTABLE ||
          ((call.spec as { command?: string; argv?: string[] }).command === DOCKER_EXECUTABLE &&
            (call.spec as { argv?: string[] }).argv?.includes("exec"))),
    )
    .map((call) => (call.spec as { argv: string[] }).argv)
    .filter((argv) => argv.some((value) => value.startsWith("--execute=")));
  assert.ok(queryRuns.length >= 2);
  const quiescenceArgv = queryRuns.find((argv) =>
    argv.some((value) => value.includes("gate6_environment_slots")),
  );
  const quiescenceSql = quiescenceArgv?.find((value) => value.startsWith("--execute=")) ?? "";
  assert.match(quiescenceSql, /information_schema\.TABLES/);
  assert.match(quiescenceSql, /PREPARE spx_gate6_quiescence/);
  assert.ok(quiescenceSql.includes("'SELECT ''absent'''"));
  for (const argv of queryRuns) {
    assert.ok(argv.findIndex((value) => value.startsWith("--execute=")) < argv.lastIndexOf("SPX"));
  }

  const pipelines = port.calls
    .filter((call) => call.kind === "pipeline")
    .map(
      (call) =>
        call.spec as {
          source: { command: string; argv: string[] };
          sink: { command: string; argv: string[] };
        },
    );
  assert.equal(pipelines.length, 2);
  const encrypt = pipelines[0];
  assert.equal(encrypt.source.command, MYSQLDUMP_EXECUTABLE);
  assert.deepEqual(encrypt.source.argv.slice(0, 7), [
    `--defaults-extra-file=${SOURCE_CREDENTIAL_FILE}`,
    "--single-transaction",
    "--quick",
    "--hex-blob",
    "--routines",
    "--triggers",
    "--events",
  ]);
  assert.equal(encrypt.source.argv.at(-1), "SPX");
  assert.equal(encrypt.sink.command, KMS_EXECUTABLE);
  assert.equal(encrypt.sink.argv[0], "encrypt");

  const decrypt = pipelines[1];
  assert.equal(decrypt.source.command, KMS_EXECUTABLE);
  assert.equal(decrypt.source.argv[0], "decrypt");
  assert.equal(decrypt.sink.command, DOCKER_EXECUTABLE);
  assert.deepEqual(decrypt.sink.argv.slice(-6), [
    "exec",
    "-T",
    "isolated-mysql",
    "mysql",
    "--defaults-extra-file=/run/secrets/isolated-client.cnf",
    "SPX",
  ]);
  assert.ok(decrypt.sink.argv.includes("exec"));
  assert.ok(decrypt.sink.argv.includes("-T"));

  const sourceIdentityRuns = port.calls.filter(
    (call) =>
      call.kind === "run" &&
      (call.spec as { command?: string }).command === MYSQL_EXECUTABLE &&
      (call.spec as { argv?: string[] }).argv?.some((value) => value.includes("@@server_uuid")),
  );
  assert.equal(sourceIdentityRuns.length, 2);
  for (const call of sourceIdentityRuns) {
    const argv = (call.spec as { argv: string[] }).argv;
    assert.ok(argv.includes(`--defaults-extra-file=${SOURCE_CREDENTIAL_FILE}`));
    assert.ok(argv.includes("--ssl-mode=VERIFY_IDENTITY"));
  }

  for (const queryToken of ["COLUMNS", "REFERENTIAL_CONSTRAINTS", "TRIGGERS"]) {
    const sourceRuns = port.calls.filter(
      (call) =>
        call.kind === "run" &&
        (call.spec as { command?: string }).command === MYSQL_EXECUTABLE &&
        (call.spec as { argv?: string[] }).argv?.some((value) => value.includes(queryToken)),
    );
    assert.equal(sourceRuns.length, 2);
  }
  const runtimeSql = port.calls
    .filter((call) => call.kind === "run")
    .flatMap((call) => (call.spec as { argv?: string[] }).argv ?? [])
    .find((value) => value.includes("information_schema.TRIGGERS"));
  assert.match(runtimeSql ?? "", /information_schema\.ROUTINES/);
  assert.match(runtimeSql ?? "", /information_schema\.EVENTS/);

  const allCalls = JSON.stringify(port.calls);
  assert.doesNotMatch(
    allCalls,
    /DROP\s+DATABASE|RENAME\s+TABLE|spx-production-backup-source\.cnf[^"]*isolated-client/i,
  );
  assert.doesNotMatch(allCalls, /\.sql(?:"|$)/i);

  const writes = port.calls
    .filter((call) => call.kind === "writeExclusive")
    .map((call) => call.spec as { path: string; mode: number });
  assert.ok(writes.some((entry) => entry.path === ISOLATED_PASSWORD_FILE && entry.mode === 0o400));
  assert.ok(writes.some((entry) => entry.path === ISOLATED_CLIENT_FILE && entry.mode === 0o400));
  const activeWriteIndex = port.calls.findIndex(
    (call) =>
      call.kind === "writeExclusive" &&
      (call.spec as { path?: string }).path === ACTIVE_OPERATION_FILE,
  );
  const backupPipelineIndex = port.calls.findIndex((call) => call.kind === "pipeline");
  assert.ok(activeWriteIndex >= 0 && activeWriteIndex < backupPipelineIndex);
  const downIndex = port.calls.findIndex(
    (call) => call.kind === "run" && (call.spec as { argv?: string[] }).argv?.includes("down"),
  );
  const firstCredentialRemoveIndex = port.calls.findIndex(
    (call) =>
      call.kind === "removeFile" &&
      [ISOLATED_PASSWORD_FILE, ISOLATED_CLIENT_FILE].includes((call.spec as { path: string }).path),
  );
  assert.ok(downIndex >= 0 && firstCredentialRemoveIndex > downIndex);
  const removed = port.calls
    .filter((call) => call.kind === "removeFile")
    .map((call) => (call.spec as { path: string }).path);
  const encryptedBackupPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`;
  const encryptionMetadataPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`;
  assert.equal(removed.includes(encryptedBackupPath), false);
  assert.equal(removed.includes(encryptionMetadataPath), false);
  assert.equal(removed.includes(ACTIVE_OPERATION_FILE), true);
  const signedPhaseIndex = port.calls.findIndex(
    (call) =>
      call.kind === "writeExclusive" &&
      (call.spec as { path?: string }).path?.includes("evidence-core-signed.json"),
  );
  const activeRemoveIndex = port.calls.findIndex(
    (call) =>
      call.kind === "removeFile" && (call.spec as { path?: string }).path === ACTIVE_OPERATION_FILE,
  );
  assert.ok(signedPhaseIndex >= 0 && activeRemoveIndex > signedPhaseIndex);
  assert.equal(
    port.calls.filter(
      (call) =>
        call.kind === "hashFile" && (call as { path?: string }).path === encryptedBackupPath,
    ).length,
    2,
  );
  assert.equal(
    port.calls.filter(
      (call) =>
        call.kind === "hashFile" && (call as { path?: string }).path === encryptionMetadataPath,
    ).length,
    2,
  );
});

test("tampered retained backup bytes reject signing and keep the active recovery marker", async () => {
  const backupPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`;
  const metadataPath = `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`;
  const hashCalls = new Map<string, number>();
  const port = makePort({
    async hashFile(path: string) {
      (port.calls as Call[]).push({ kind: "hashFile", path });
      const count = (hashCalls.get(path) ?? 0) + 1;
      hashCalls.set(path, count);
      if (path === backupPath) return count === 1 ? H("c") : H("e");
      if (path === metadataPath) return H("d");
      return H("f");
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const backup = await prepareRetainedBackupForSigning(adapter);
  await assert.rejects(
    adapter.signEvidenceCore({
      schemaVersion: 1,
      backupSha256: backup.backupSha256,
      encryptionMetadataSha256: backup.encryptionMetadataSha256,
    }),
    /retained.*hash|backup.*changed|binding/i,
  );
  assert.equal(
    port.calls.some(
      (call) =>
        call.kind === "run" &&
        (call.spec as { command?: string; argv?: string[] }).command === KMS_EXECUTABLE &&
        (call.spec as { argv?: string[] }).argv?.[0] === "sign",
    ),
    false,
  );
  assert.equal(
    port.calls.some(
      (call) =>
        call.kind === "removeFile" &&
        (call.spec as { path?: string }).path === ACTIVE_OPERATION_FILE,
    ),
    false,
  );
});

test("KMS sign failure leaves retained outputs and marker for abandoned recovery", async () => {
  const port = makePort({
    async run(spec: { command: string; argv: string[] }) {
      if (spec.command === KMS_EXECUTABLE && spec.argv[0] === "sign") {
        (port.calls as Call[]).push({ kind: "run", spec });
        throw new Error("simulated-kms-sign-failure");
      }
      return defaultRun(port.calls as Call[], spec);
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const backup = await prepareRetainedBackupForSigning(adapter);
  await assert.rejects(
    adapter.signEvidenceCore({
      schemaVersion: 1,
      backupSha256: backup.backupSha256,
      encryptionMetadataSha256: backup.encryptionMetadataSha256,
    }),
    /simulated-kms-sign-failure/,
  );
  const removed = port.calls
    .filter((call) => call.kind === "removeFile")
    .map((call) => (call.spec as { path: string }).path);
  assert.equal(removed.includes(ACTIVE_OPERATION_FILE), false);
  assert.equal(
    removed.includes(`${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`),
    false,
  );
  assert.equal(
    removed.includes(
      `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`,
    ),
    false,
  );
});

test("invalid downstream signature encodings retain the recovery marker before durable signing", async () => {
  const invalidSignatures = [
    {
      label: "undersized",
      value: Buffer.alloc(15, 0x41).toString("base64"),
    },
    {
      label: "noncanonical-padding",
      value: "AAAA=",
    },
    {
      label: "oversized-canonical",
      value: Buffer.alloc(12_289, 0x42).toString("base64"),
    },
    {
      label: "secret-shaped-decoded-text",
      value: Buffer.from("password=supersecret12345", "utf8").toString("base64"),
    },
  ];

  for (const invalid of invalidSignatures) {
    const port = makePort({
      async run(spec: { command: string; argv: string[] }) {
        if (spec.command === KMS_EXECUTABLE && spec.argv[0] === "sign") {
          (port.calls as Call[]).push({ kind: "run", spec });
          return { stdout: `${invalid.value}\n` };
        }
        return defaultRun(port.calls as Call[], spec);
      },
    });
    const adapter = createProductionBackupLiveAdapter(validContext, port);
    const backup = await prepareRetainedBackupForSigning(adapter);
    await assert.rejects(
      adapter.signEvidenceCore({
        schemaVersion: 1,
        backupSha256: backup.backupSha256,
        encryptionMetadataSha256: backup.encryptionMetadataSha256,
      }),
      /signature.*invalid|signature.*secret|secret-shaped/i,
      invalid.label,
    );
    assert.equal(
      port.calls.some(
        (call) =>
          call.kind === "writeExclusive" &&
          (call.spec as { path?: string }).path?.includes("evidence-core-signed.json"),
      ),
      false,
      `${invalid.label}: signed phase must not be durable`,
    );
    assert.equal(
      port.calls.some(
        (call) =>
          call.kind === "removeFile" &&
          (call.spec as { path?: string }).path === ACTIVE_OPERATION_FILE,
      ),
      false,
      `${invalid.label}: active marker must remain`,
    );
  }
});

test("failed backup capture cleanup deletes partial outputs and active marker", async () => {
  const port = makePort({
    async pipeline(spec: unknown) {
      (port.calls as Call[]).push({ kind: "pipeline", spec });
      throw new Error("simulated-encryption-pipeline-failure");
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const fingerprint = await adapter.readProductionFingerprint();
  await assert.rejects(
    adapter.createEncryptedBackup({ context: validContext, productionFingerprint: fingerprint }),
    /simulated-encryption-pipeline-failure/,
  );
  await adapter.destroyIsolatedRestore();
  const removed = port.calls
    .filter((call) => call.kind === "removeFile")
    .map((call) => (call.spec as { path: string }).path);
  assert.ok(
    removed.includes(`${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`),
  );
  assert.ok(
    removed.includes(
      `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`,
    ),
  );
  assert.ok(removed.includes(ACTIVE_OPERATION_FILE));
});

test("system hashing is streaming rather than buffering a backup-sized file", async () => {
  const source = await readFile("scripts/lib/production-backup-live-adapter.mjs", "utf8");
  assert.match(source, /createReadStream\(/);
  assert.doesNotMatch(source, /hashFile\(path\)[\s\S]{0,180}secureReadBytes\(path/);
  assert.match(source, /node:stream\/promises/);
  assert.match(source, /streamPipeline\(source\.stdout, sink\.stdin\)/);
  assert.match(source, /\.once\("close"/);
  assert.doesNotMatch(source, /\.once\("exit"/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /stream\.destroy\(/);
});

test("backup capture rejects a changed authenticated source identity", async () => {
  let identityProbe = 0;
  const port = makePort({
    async run(spec: { command: string; argv: string[] }) {
      const sql = spec.argv.find((value) => value.startsWith("--execute=")) ?? "";
      if (spec.command === MYSQL_EXECUTABLE && sql.includes("@@server_uuid")) {
        (port.calls as Call[]).push({ kind: "run", spec });
        identityProbe += 1;
        return {
          stdout:
            identityProbe === 1
              ? "550e8400-e29b-41d4-a716-446655440000\t8.4.0\tSPX\n"
              : "550e8400-e29b-41d4-a716-446655440001\t8.4.0\tSPX\n",
        };
      }
      return defaultRun(port.calls as Call[], spec);
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const fingerprint = await adapter.readProductionFingerprint();
  await assert.rejects(
    adapter.createEncryptedBackup({ context: validContext, productionFingerprint: fingerprint }),
    /source.*identity.*changed|fingerprint.*changed/i,
  );
});

test("backup capture rejects changed source invariants before isolated restore", async () => {
  let sourceSchemaProbe = 0;
  const port = makePort({
    async run(spec: { command: string; argv: string[] }) {
      const sql = spec.argv.find((value) => value.startsWith("--execute=")) ?? "";
      if (spec.command === MYSQL_EXECUTABLE && sql.includes("COLUMNS")) {
        (port.calls as Call[]).push({ kind: "run", spec });
        sourceSchemaProbe += 1;
        return { stdout: sourceSchemaProbe === 1 ? "schema-shape\n" : "changed-schema-shape\n" };
      }
      return defaultRun(port.calls as Call[], spec);
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const fingerprint = await adapter.readProductionFingerprint();
  await assert.rejects(
    adapter.createEncryptedBackup({ context: validContext, productionFingerprint: fingerprint }),
    /source.*invariant.*changed/i,
  );
});

test("fixed invariants reject an isolated result that differs from the source snapshot", async () => {
  const port = makePort({
    async run(spec: { command: string; argv: string[] }) {
      const sql = spec.argv.find((value) => value.startsWith("--execute=")) ?? "";
      if (
        spec.command === DOCKER_EXECUTABLE &&
        spec.argv.includes("exec") &&
        sql.includes("REFERENTIAL_CONSTRAINTS")
      ) {
        (port.calls as Call[]).push({ kind: "run", spec });
        return { stdout: "isolated-fk-mismatch\n" };
      }
      return defaultRun(port.calls as Call[], spec);
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const fingerprint = await adapter.readProductionFingerprint();
  const backup = await adapter.createEncryptedBackup({
    context: validContext,
    productionFingerprint: fingerprint,
  });
  await adapter.startIsolatedRestore({ backupSha256: backup.backupSha256 });
  const restore = await adapter.restoreBackup({ backupSha256: backup.backupSha256 });
  await assert.rejects(
    adapter.verifyFixedInvariants({ restore }),
    /isolated.*invariant.*mismatch/i,
  );
});

test("caller-selected path, SQL, database, service, and process options are rejected", async () => {
  const adapter = createProductionBackupLiveAdapter(validContext, makePort());
  for (const unsafe of [
    { path: "/tmp/backup.sql" },
    { sql: "DROP DATABASE spx" },
    { database: "SPX" },
    { service: "production-mysql" },
    { argv: ["rm", "-rf", "/"] },
    { env: { PATH: "/tmp" } },
  ]) {
    await assert.rejects(adapter.restoreBackup(unsafe), /caller.*override/i);
  }
});

test("quiescence rejects an active host lock or Gate 6 database slot", async () => {
  const hostBusy = createProductionBackupLiveAdapter(
    validContext,
    makePort({
      async inspectHostLock() {
        return { state: "installing" };
      },
    }),
  );
  await assert.rejects(hostBusy.assertMutationQuiescent("before-capture"), /quiescent/i);

  const gateBusy = createProductionBackupLiveAdapter(
    validContext,
    makePort({
      async run(spec: { command: string; argv: string[] }) {
        if (
          spec.command === MYSQL_EXECUTABLE &&
          spec.argv.some((value) => value.includes("gate6_environment_slots"))
        ) {
          return { stdout: "busy\n" };
        }
        return { stdout: "verified-source-probe\n" };
      },
    }),
  );
  await assert.rejects(gateBusy.assertMutationQuiescent("after-teardown"), /quiescent/i);
});

test("restart recovery targets only the recorded isolated operation resources", async () => {
  const operationIdentitySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        candidateSha: validContext.candidateSha,
        operationId: validContext.operationId,
        targetDescriptorSha256: validContext.targetDescriptorSha256,
      }),
    )
    .digest("hex");
  const active = {
    schemaVersion: 1,
    operationId: validContext.operationId,
    candidateSha: validContext.candidateSha,
    targetDescriptorSha256: validContext.targetDescriptorSha256,
    operationIdentitySha256,
  };
  const port = makePort({
    async readSecureJson(spec: { path: string }) {
      (port.calls as Call[]).push({ kind: "readSecureJson", spec });
      return spec.path.endsWith("active-operation.json") ? active : null;
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const result = await adapter.recoverAbandonedOperation();
  assert.equal(result.recovered, true);
  const down = port.calls.find(
    (call) => call.kind === "run" && (call.spec as { argv?: string[] }).argv?.includes("down"),
  );
  assert.ok(down);
  const argv = (down!.spec as { argv: string[] }).argv;
  assert.ok(argv.includes(`spx-backup-restore-${validContext.operationId}`));
  assert.doesNotMatch(argv.join(" "), /production-mysql|spx-production(?:\s|$)|DROP|RENAME/i);
  const removed = port.calls
    .filter((call) => call.kind === "removeFile")
    .map((call) => (call.spec as { path: string }).path);
  assert.ok(
    removed.includes(`${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encrypted-backup.bin`),
  );
  assert.ok(
    removed.includes(
      `${BACKUP_OPERATIONS_ROOT}/${validContext.operationId}/encryption-metadata.json`,
    ),
  );
  assert.ok(removed.includes(ACTIVE_OPERATION_FILE));
});

test("recovery rejects a forged active-operation binding", async () => {
  const port = makePort({
    async readSecureJson(spec: { path: string }) {
      (port.calls as Call[]).push({ kind: "readSecureJson", spec });
      return spec.path.endsWith("active-operation.json")
        ? {
            schemaVersion: 1,
            operationId: validContext.operationId,
            candidateSha: validContext.candidateSha,
            targetDescriptorSha256: validContext.targetDescriptorSha256,
            operationIdentitySha256: H("e"),
          }
        : null;
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  await assert.rejects(adapter.recoverAbandonedOperation(), /recovery.*record|binding/i);
  assert.equal(
    port.calls.some(
      (call) => call.kind === "run" && (call.spec as { argv?: string[] }).argv?.includes("down"),
    ),
    false,
  );
});

test("failed Compose teardown retains credentials and the durable recovery marker", async () => {
  const port = makePort({
    async run(spec: { command: string; argv: string[] }) {
      if (spec.command === DOCKER_EXECUTABLE && spec.argv.includes("down")) {
        (port.calls as Call[]).push({ kind: "run", spec });
        throw new Error("simulated-compose-down-failure");
      }
      return defaultRun(port.calls as Call[], spec);
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  const fingerprint = await adapter.readProductionFingerprint();
  const backup = await adapter.createEncryptedBackup({
    context: validContext,
    productionFingerprint: fingerprint,
  });
  await adapter.startIsolatedRestore({ backupSha256: backup.backupSha256 });
  await assert.rejects(adapter.destroyIsolatedRestore(), /teardown/i);
  const removed = port.calls
    .filter((call) => call.kind === "removeFile")
    .map((call) => (call.spec as { path: string }).path);
  assert.equal(removed.includes(ISOLATED_PASSWORD_FILE), false);
  assert.equal(removed.includes(ISOLATED_CLIENT_FILE), false);
  assert.equal(
    removed.some((path) => path.endsWith("active-operation.json")),
    false,
  );
});

test("journal sequence resumes above durable phase files", async () => {
  const port = makePort({
    async listSecureDirectory(path: string) {
      (port.calls as Call[]).push({ kind: "listSecureDirectory", path });
      return path.endsWith("/journal")
        ? ["0001-0011223344556677-adapter-initialized.json", "0007-8899aabbccddeeff-old-phase.json"]
        : [];
    },
  });
  const adapter = createProductionBackupLiveAdapter(validContext, port);
  await adapter.readProductionFingerprint();
  const journalWrites = port.calls
    .filter((call) => call.kind === "writeExclusive")
    .map((call) => (call.spec as { path: string }).path)
    .filter((path) => path.includes("/journal/"));
  assert.ok(journalWrites[0].includes("/0008-"));
  assert.ok(journalWrites[1].includes("/0009-"));
});

test("test process/filesystem ports cannot be injected in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => createProductionBackupLiveAdapter(validContext, makePort()),
      /test.*port|injection/i,
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
});
