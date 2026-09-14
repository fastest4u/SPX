import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquireProductionMutationLock,
  beginProductionMutationGate6Handoff,
  commitProductionInstallHostLock,
  markProductionInstallBootstrapOwned,
  markProductionInstallAwaitingGate6,
  markProductionMutationTerminal,
  readProductionMutationLock,
  reconcileProductionMutationGate6Handoff,
  reconcileProductionMutationLock,
} from "../scripts/production-mutation-host-lock.mjs";
import {
  claimProtectedInstallBootstrapSlot,
  commitProtectedInstallGate6Slot,
  compensateProtectedInstallBootstrapSlot,
  executeGate6SlotQuery,
  finalizeProtectedInstallGate6Slot,
  inspectProtectedInstallSlot,
  parseGate6ControlDatabaseConfig,
  parseGate6SlotQueryOutput,
  renderGate6MysqlDefaults,
  reconcileProtectedInstallHandoffOnce,
  validateGate6CapabilityFileMetadata,
  validateGate6ControlDatabasePassword,
} from "../scripts/protected-install-watchdog.mjs";
import { mysqlScriptConnectionConfigFromEnv } from "../scripts/lib/mysql-connection-config.mjs";
import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";

const H = (character: string): string => character.repeat(64);
const SOURCE_SHA = "1".repeat(40);
const START_MS = Date.parse("2026-07-11T01:00:00.000Z");
const FINAL_HEARTBEAT_AT = "2026-07-11T01:10:10.000Z";
const FINAL_EXPIRES_AT = "2026-07-12T01:10:10.000Z";

interface SlotRow {
  environment: string;
  owner_type: string;
  owner_id: string;
  operation_id: string;
  transfer_token_sha256: string | null;
  state: string;
  version: number;
  uncompensated_work: number;
  protected_install_evidence_sha256: string;
  release_sha: string;
  target_descriptor_sha256: string;
  operator_bundle_sha256: string;
  installed_migration_set_sha256: string;
  installed_schema_version: number;
  heartbeat_at: string;
  expires_at: string;
}

class FakeGate6Connection {
  slot: SlotRow | null = null;
  private transactionSlot: SlotRow | null = null;
  commits = 0;
  rollbacks = 0;

  async beginTransaction(): Promise<void> {
    this.transactionSlot = this.slot === null ? null : structuredClone(this.slot);
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<[unknown, unknown]> {
    if (/SELECT[\s\S]+FROM gate6_environment_slots/i.test(sql)) {
      const selected = /FOR UPDATE/i.test(sql) ? this.transactionSlot : this.slot;
      return [selected === null ? [] : [structuredClone(selected)], []];
    }
    if (/INSERT INTO gate6_environment_slots/i.test(sql)) {
      if (this.transactionSlot !== null) return [{ affectedRows: 0 }, []];
      this.transactionSlot = {
        environment: "production",
        owner_type: "protected-install",
        owner_id: String(parameters[0]),
        operation_id: String(parameters[1]),
        transfer_token_sha256: String(parameters[2]),
        state: "installing",
        version: 1,
        uncompensated_work: 0,
        protected_install_evidence_sha256: String(parameters[3]),
        release_sha: String(parameters[4]),
        target_descriptor_sha256: String(parameters[5]),
        operator_bundle_sha256: String(parameters[6]),
        installed_migration_set_sha256: String(parameters[7]),
        installed_schema_version: Number(parameters[8]),
        heartbeat_at: String(parameters[9]),
        expires_at: String(parameters[10]),
      };
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE gate6_environment_slots[\s\S]+SET state = 'installed-awaiting-gate6'/i.test(sql)) {
      const preparedCommit = parameters.length === 12;
      if (
        this.transactionSlot === null
        || this.transactionSlot.state !== "installing"
        || this.transactionSlot.owner_id !== String(parameters[4])
        || this.transactionSlot.operation_id !== String(parameters[5])
        || (!preparedCommit && this.transactionSlot.transfer_token_sha256 !== String(parameters[6]))
        || (!preparedCommit && this.transactionSlot.protected_install_evidence_sha256 !== String(parameters[7]))
        || this.transactionSlot.version !== Number(parameters[preparedCommit ? 11 : 13])
      ) return [{ affectedRows: 0 }, []];
      this.transactionSlot = {
        ...this.transactionSlot,
        state: "installed-awaiting-gate6",
        version: this.transactionSlot.version + 1,
        protected_install_evidence_sha256: String(parameters[0]),
        heartbeat_at: String(parameters[1]),
        expires_at: String(parameters[2]),
      };
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE gate6_environment_slots[\s\S]+SET state = 'released'/i.test(sql)) {
      if (
        this.transactionSlot === null
        || this.transactionSlot.state !== "installing"
        || this.transactionSlot.owner_type !== "protected-install"
        || this.transactionSlot.owner_id !== String(parameters[3])
        || this.transactionSlot.operation_id !== String(parameters[4])
        || this.transactionSlot.transfer_token_sha256 !== String(parameters[5])
        || this.transactionSlot.version !== Number(parameters[6])
      ) return [{ affectedRows: 0 }, []];
      this.transactionSlot = {
        ...this.transactionSlot,
        transfer_token_sha256: null,
        state: "released",
        version: this.transactionSlot.version + 1,
        uncompensated_work: 0,
        heartbeat_at: String(parameters[0]),
        expires_at: String(parameters[1]),
      };
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE gate6_environment_slots/i.test(sql)) {
      if (
        this.transactionSlot === null
        || this.transactionSlot.state !== "released"
        || this.transactionSlot.uncompensated_work !== 0
        || this.transactionSlot.version !== Number(parameters[13])
      ) return [{ affectedRows: 0 }, []];
      this.transactionSlot = {
        ...this.transactionSlot,
        owner_type: "protected-install",
        owner_id: String(parameters[0]),
        operation_id: String(parameters[1]),
        transfer_token_sha256: String(parameters[2]),
        state: "installing",
        version: this.transactionSlot.version + 1,
        uncompensated_work: 0,
        protected_install_evidence_sha256: String(parameters[3]),
        release_sha: String(parameters[4]),
        target_descriptor_sha256: String(parameters[5]),
        operator_bundle_sha256: String(parameters[6]),
        installed_migration_set_sha256: String(parameters[7]),
        installed_schema_version: Number(parameters[8]),
        heartbeat_at: String(parameters[9]),
        expires_at: String(parameters[10]),
      };
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async commit(): Promise<void> {
    this.slot = this.transactionSlot === null ? null : structuredClone(this.transactionSlot);
    this.commits += 1;
  }

  async rollback(): Promise<void> {
    this.transactionSlot = null;
    this.rollbacks += 1;
  }

  transferToGate6(gate6Id: string): void {
    assert.ok(this.slot);
    this.slot.owner_type = "gate6";
    this.slot.owner_id = gate6Id;
    this.slot.transfer_token_sha256 = null;
    this.slot.state = "active";
    this.slot.version += 1;
  }
}

const slotInput = {
  operationId: "deploy-100-1-production",
  transferTokenSha256: H("2"),
  installIntentEvidenceSha256: H("3"),
  releaseSha: SOURCE_SHA,
  targetDescriptorSha256: H("b"),
  operatorBundleSha256: H("4"),
  installedMigrationSetSha256: H("5"),
  installedSchemaVersion: 36,
  heartbeatAt: "2026-07-11T01:00:10.000Z",
  expiresAt: "2026-07-11T02:00:10.000Z",
} as const;
const FINAL_EVIDENCE_SHA256 = H("f");

const preparedDatabaseCommit = {
  operationId: slotInput.operationId,
  releaseSha: slotInput.releaseSha,
  targetDescriptorSha256: slotInput.targetDescriptorSha256,
  operatorBundleSha256: slotInput.operatorBundleSha256,
  installedMigrationSetSha256: slotInput.installedMigrationSetSha256,
  installedSchemaVersion: slotInput.installedSchemaVersion,
  protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
  heartbeatAt: FINAL_HEARTBEAT_AT,
  expiresAt: FINAL_EXPIRES_AT,
  expectedCurrentVersion: 1,
  expectedNextVersion: 2,
} as const;

const preparedHostCommit = {
  operationId: slotInput.operationId,
  releaseSha: slotInput.releaseSha,
  targetDescriptorSha256: slotInput.targetDescriptorSha256,
  operatorBundleSha256: slotInput.operatorBundleSha256,
  protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
  heartbeatAt: FINAL_HEARTBEAT_AT,
  expiresAt: FINAL_EXPIRES_AT,
  expectedCurrentVersion: 2,
  expectedNextVersion: 3,
} as const;

function hostIdentity(stateDir: string, leaseOwner = `workflow:${slotInput.operationId}`) {
  return {
    stateDir,
    operationId: slotInput.operationId,
    releaseHash: H("a"),
    targetHash: slotInput.targetDescriptorSha256,
    leaseOwner,
    nowMs: START_MS + 10_000,
    allowNonRoot: true,
  } as const;
}

async function acquireInstallLock(stateDir: string): Promise<void> {
  await acquireProductionMutationLock({
    stateDir,
    nowMs: START_MS,
    allowNonRoot: true,
    request: {
      operationId: slotInput.operationId,
      operationType: "install",
      releaseHash: H("a"),
      targetHash: slotInput.targetDescriptorSha256,
      state: "installing",
      rollbackJournalHash: H("6"),
      rollbackIdentity: {
        project: "spx-production",
        releaseHash: H("7"),
        imageDigest: `sha256:${H("8")}`,
        serviceSetHash: H("9"),
        configHash: H("c"),
      },
      lease: { owner: `workflow:${slotInput.operationId}`, durationMs: 60_000 },
    },
  });
}

async function prepareInstallOwners(
  stateDir: string,
  connection: FakeGate6Connection,
): Promise<void> {
  await acquireProductionMutationLock({
    stateDir,
    nowMs: START_MS,
    allowNonRoot: true,
    request: {
      operationId: slotInput.operationId,
      operationType: "install",
      releaseHash: H("a"),
      targetHash: slotInput.targetDescriptorSha256,
      state: "installing",
      rollbackJournalHash: H("6"),
      rollbackIdentity: {
        project: "spx-production",
        releaseHash: H("7"),
        imageDigest: `sha256:${H("8")}`,
        serviceSetHash: H("9"),
        configHash: H("c"),
      },
      lease: { owner: `workflow:${slotInput.operationId}`, durationMs: 60 * 60 * 1_000 },
    },
  });
  await claimProtectedInstallBootstrapSlot(connection, slotInput);
  await markProductionInstallBootstrapOwned({
    ...hostIdentity(stateDir),
    binding: {
      ...slotInput,
      slotVersion: 1,
    },
  });
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixedPreparedCommit(root: string): Promise<string> {
  const directory = join(root, "prepared", slotInput.operationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "committed"), { recursive: true, mode: 0o700 });
  const core = {
    operationId: slotInput.operationId,
    candidateSha: slotInput.releaseSha,
    releaseManifestSha256: H("a"),
    productionTargetDescriptorSha256: slotInput.targetDescriptorSha256,
    installedOperatorBundleSha256: slotInput.operatorBundleSha256,
    installedMigrationSetSha256: slotInput.installedMigrationSetSha256,
    afterSchema: slotInput.installedSchemaVersion,
    finalLease: {
      heartbeatAt: FINAL_HEARTBEAT_AT,
      expiresAt: FINAL_EXPIRES_AT,
    },
  };
  const coreBytes = canonicalJson(core);
  const signature = {
    schemaVersion: 1,
    algorithm: "kms-sha256",
    keyId: "alias/spx-protected-install-evidence",
    subjectSha256: sha256Bytes(coreBytes),
    signatureBase64: "YWJjZA==",
    signedAt: FINAL_HEARTBEAT_AT,
  };
  const signatureBytes = canonicalJson(signature);
  const evidence = {
    ...core,
    signatureSha256: sha256Bytes(signatureBytes),
  };
  const evidenceBytes = canonicalJson(evidence);
  const record = {
    schemaVersion: 1,
    operationId: slotInput.operationId,
    releaseSha: slotInput.releaseSha,
    releaseManifestSha256: H("a"),
    targetDescriptorSha256: slotInput.targetDescriptorSha256,
    operatorBundleSha256: slotInput.operatorBundleSha256,
    installedMigrationSetSha256: slotInput.installedMigrationSetSha256,
    installedSchemaVersion: slotInput.installedSchemaVersion,
    evidenceCoreSha256: sha256Bytes(coreBytes),
    signatureSha256: sha256Bytes(signatureBytes),
    protectedInstallEvidenceSha256: sha256Bytes(evidenceBytes),
    expectedHostLock: { currentVersion: 2, nextVersion: 3 },
    expectedDatabaseSlot: { currentVersion: 1, nextVersion: 2 },
    heartbeatAt: FINAL_HEARTBEAT_AT,
    expiresAt: FINAL_EXPIRES_AT,
  };
  for (const [name, source] of [
    ["evidence-core.json", coreBytes],
    ["protected-install-signature.json", signatureBytes],
    ["protected-install-evidence.json", evidenceBytes],
    ["prepared-commit.json", canonicalJson(record)],
  ] as const) {
    await writeFile(join(directory, name), source, { encoding: "utf8", mode: 0o400 });
  }
  return record.protectedInstallEvidenceSha256;
}

async function main(): Promise<void> {
  const watchdogSource = readFileSync("scripts/protected-install-watchdog.mjs", "utf8");
  assert.match(watchdogSource, /\/usr\/bin\/mysql/);
  assert.match(watchdogSource, /--defaults-extra-file=/);
  assert.match(watchdogSource, /shell:\s*false/);
  assert.doesNotMatch(watchdogSource, /--password|MYSQL_PWD/);
  assert.match(watchdogSource, /constants\.O_EXCL/);
  assert.match(watchdogSource, /constants\.O_NOFOLLOW/);
  assert.match(watchdogSource, /unlinkSync/);
  const mysql2ImportIndex = watchdogSource.indexOf('await import("mysql2/promise")');
  assert.ok(mysql2ImportIndex > watchdogSource.indexOf('action === "validate-host-capability"'));
  assert.ok(mysql2ImportIndex > watchdogSource.indexOf('action === "reconcile-loop"'));
  const pinnedClosureRoot = await mkdtemp(join(tmpdir(), "spx-pinned-watchdog-"));
  try {
    const pinnedFiles = [
      "scripts/protected-install-watchdog.mjs",
      "scripts/production-mutation-host-lock.mjs",
      "scripts/lib/mysql-connection-config.mjs",
      "scripts/lib/file-backed-secret.mjs",
      "scripts/lib/safe-file.mjs",
    ];
    for (const path of pinnedFiles) {
      const destination = join(pinnedClosureRoot, ...path.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await copyFile(path, destination);
    }
    const pinnedModuleUrl = pathToFileURL(
      join(pinnedClosureRoot, "scripts", "protected-install-watchdog.mjs"),
    ).href;
    const importedWithoutNodeModules = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", "await import(process.env.SPX_PINNED_MODULE_URL)"],
      {
        encoding: "utf8",
        env: { ...process.env, SPX_PINNED_MODULE_URL: pinnedModuleUrl },
      },
    );
    assert.equal(importedWithoutNodeModules.status, 0, importedWithoutNodeModules.stderr);
  } finally {
    await rm(pinnedClosureRoot, { recursive: true, force: true });
  }
  const watchdogUnit = readFileSync("deploy/systemd/spx-protected-install-watchdog@.service", "utf8");
  assert.match(watchdogUnit, /^User=root$/m);
  assert.match(watchdogUnit, /protected-install-watchdog\.mjs --action=reconcile-loop/);
  assert.match(watchdogUnit, /^RuntimeDirectory=spx-protected-install$/m);
  assert.match(watchdogUnit, /^RuntimeDirectoryMode=0700$/m);
  assert.match(
    watchdogUnit,
    /^ExecStart=\/usr\/bin\/node \/var\/lib\/spx-protected-install\/watchdogs\/%i\/scripts\/protected-install-watchdog\.mjs --action=reconcile-loop$/m,
  );
  assert.match(watchdogUnit, /\/var\/lib\/spx-gate6\/gate6-control-db\.json/);
  assert.match(watchdogUnit, /\/var\/lib\/spx-gate6\/secrets\/gate6-control-db-password/);
  assert.match(watchdogUnit, /\/var\/lib\/spx-gate6\/config\/db-ca\.pem/);
  assert.doesNotMatch(watchdogUnit, /\/root\/SPX|spx-protected-install-watchdog\.service/);
  assert.doesNotMatch(watchdogUnit, /NODE_PATH|node_modules/);
  assert.doesNotMatch(watchdogUnit, /docker\.sock|ExecStart=.*docker/);

  const tlsRoot = await mkdtemp(join(tmpdir(), "spx-gate6-claim-tls-"));
  try {
    const caPath = join(tlsRoot, "ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
    const proxiedClaim = mysqlScriptConnectionConfigFromEnv({
      NODE_ENV: "production",
      DB_MODE: "mysql",
      DB_HOST: "gate6-db-proxy",
      DB_PORT: "3306",
      DB_NAME: "spx",
      DB_USERNAME: "spx_gate6_control",
      DB_PASSWORD: "test-only",
      DB_SSL_MODE: "verify-identity",
      DB_SSL_CA_FILE: caPath,
      DB_SSL_SERVERNAME: "mysql-upstream.internal",
    });
    assert.equal(proxiedClaim.missing.length, 0);
    assert.equal(proxiedClaim.value?.ssl?.servername, "mysql-upstream.internal");
  } finally {
    await rm(tlsRoot, { recursive: true, force: true });
  }

  const metadata = { isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100400, size: 128 };
  assert.doesNotThrow(() => validateGate6CapabilityFileMetadata(metadata, "config"));
  assert.throws(() => validateGate6CapabilityFileMetadata({ ...metadata, mode: 0o100600 }, "config"), /invalid/);
  assert.throws(() => validateGate6CapabilityFileMetadata({ ...metadata, uid: 1000 }, "config"), /invalid/);
  assert.throws(() => validateGate6CapabilityFileMetadata({ ...metadata, isSymbolicLink: true }, "config"), /invalid/);
  const capability = {
    schemaVersion: 1,
    host: "mysql.production.example",
    port: 3306,
    database: "spx",
    username: "spx_gate6_control",
    sslServername: "mysql.production.example",
    targetDescriptorSha256: slotInput.targetDescriptorSha256,
    passwordSha256: H("7"),
    caSha256: H("8"),
  } as const;
  assert.deepEqual(
    parseGate6ControlDatabaseConfig(JSON.stringify(capability), slotInput.targetDescriptorSha256),
    capability,
  );
  assert.throws(
    () => parseGate6ControlDatabaseConfig(
      JSON.stringify({ ...capability, sslServername: "different.production.example" }),
      slotInput.targetDescriptorSha256,
    ),
    /invalid/,
  );
  assert.throws(
    () => parseGate6ControlDatabaseConfig(JSON.stringify(capability), H("9")),
    /target|invalid/,
  );
  const safePassword = "Abc123_-".repeat(4);
  assert.equal(validateGate6ControlDatabasePassword(safePassword), safePassword);
  for (const ambiguousPassword of [
    "A".repeat(31) + "#",
    "A".repeat(31) + ";",
    "A".repeat(31) + "'",
    "A".repeat(31) + '"',
    "A".repeat(31) + "\\",
    ` ${"A".repeat(32)}`,
    `${"A".repeat(32)} `,
    `${"A".repeat(32)}\n`,
  ]) {
    assert.throws(() => validateGate6ControlDatabasePassword(ambiguousPassword), /invalid/);
  }
  const renderedDefaults = renderGate6MysqlDefaults(capability, safePassword);
  assert.match(renderedDefaults, /^\[client\]$/m);
  assert.match(renderedDefaults, /^password=Abc123_-/m);
  assert.match(renderedDefaults, /^ssl-mode=VERIFY_IDENTITY$/m);
  assert.match(renderedDefaults, /^ssl-ca=\/var\/lib\/spx-gate6\/config\/db-ca\.pem$/m);
  assert.equal(parseGate6SlotQueryOutput(""), null);
  assert.throws(() => parseGate6SlotQueryOutput("not-json\n"), /malformed/);
  assert.throws(() => parseGate6SlotQueryOutput("{}\n"), /malformed/);
  assert.throws(() => parseGate6SlotQueryOutput("{}\n{}\n"), /ambiguous/);
  let capturedArgs: string[] = [];
  let capturedOptions: Record<string, unknown> = {};
  const fsOperations: string[] = [];
  let ephemeralBytes = "";
  let ephemeralFlags = 0;
  let ephemeralMode = 0;
  const fakeFs = {
    lstatSync: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o40700,
    }),
    openSync: (path: string, flags: number, mode?: number) => {
      fsOperations.push(`open:${path}:${flags}:${mode ?? ""}`);
      if (path !== "/run/spx-protected-install") {
        ephemeralFlags = flags;
        ephemeralMode = mode ?? 0;
      }
      return path === "/run/spx-protected-install" ? 2 : 1;
    },
    writeSync: (_descriptor: number, value: Uint8Array) => {
      ephemeralBytes = Buffer.from(value).toString("utf8");
      fsOperations.push("write");
      return value.byteLength;
    },
    fsyncSync: (descriptor: number) => { fsOperations.push(`fsync:${descriptor}`); },
    closeSync: (descriptor: number) => { fsOperations.push(`close:${descriptor}`); },
    unlinkSync: (path: string) => { fsOperations.push(`unlink:${path}`); },
  };
  executeGate6SlotQuery({
    capability,
    password: safePassword,
    runtimeDirectory: "/run/spx-protected-install",
    nonce: "0123456789abcdef",
    fsAdapter: fakeFs,
    spawnImpl: (_command: string, args: string[], options: Record<string, unknown>) => {
      capturedArgs = args;
      capturedOptions = options;
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(
    capturedArgs[0],
    "--defaults-extra-file=/run/spx-protected-install/gate6-control-0123456789abcdef.cnf",
  );
  assert.equal(capturedOptions.shell, false);
  assert.equal(capturedArgs.includes("--ssl-mode=VERIFY_IDENTITY"), true);
  assert.equal(capturedArgs.includes("--database=spx"), true);
  assert.equal(capturedArgs.includes("--host=mysql.production.example"), true);
  assert.equal(capturedArgs.includes("--user=spx_gate6_control"), true);
  assert.equal(capturedArgs.some((argument) => argument.includes(safePassword)), false);
  assert.equal(
    (capturedOptions.env as Record<string, string>).HOME,
    "/run/spx-protected-install",
  );
  assert.equal(ephemeralBytes, renderedDefaults);
  assert.equal((ephemeralFlags & constants.O_EXCL) === constants.O_EXCL, true);
  assert.equal((ephemeralFlags & (constants.O_NOFOLLOW ?? 0)) === (constants.O_NOFOLLOW ?? 0), true);
  assert.equal(ephemeralMode, 0o400);
  assert.ok(fsOperations.some((entry) => entry.startsWith("unlink:/run/spx-protected-install/")));
  assert.deepEqual(fsOperations.slice(-3), [
    "open:/run/spx-protected-install:0:",
    "fsync:2",
    "close:2",
  ]);
  assert.throws(
    () => executeGate6SlotQuery({
      capability,
      password: safePassword,
      runtimeDirectory: "/run/spx-protected-install",
      nonce: "fedcba9876543210",
      fsAdapter: fakeFs,
      spawnImpl: () => ({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    }),
    /mysql client unavailable/,
  );
  assert.ok(
    fsOperations.some((entry) => entry === "unlink:/run/spx-protected-install/gate6-control-fedcba9876543210.cnf"),
  );
  const sanitizedCli = spawnSync(process.execPath, [
    "scripts/protected-install-watchdog.mjs",
    "--action=invalid-secret-mysql.production.example",
  ], { encoding: "utf8" });
  assert.equal(sanitizedCli.status, 1);
  assert.equal(sanitizedCli.stderr, "protected-install-operation-failed\n");
  assert.doesNotMatch(sanitizedCli.stderr, /mysql\.production\.example/);

  const connection = new FakeGate6Connection();
  const first = await claimProtectedInstallBootstrapSlot(connection, slotInput);
  assert.deepEqual(first, { status: "installing", slotVersion: 1, idempotent: false });
  assert.equal(connection.slot?.owner_type, "protected-install");
  assert.equal(connection.slot?.transfer_token_sha256, slotInput.transferTokenSha256);
  const second = await claimProtectedInstallBootstrapSlot(connection, slotInput);
  assert.deepEqual(second, { status: "installing", slotVersion: 1, idempotent: true });
  assert.equal(connection.commits, 2);

  const compensationConnection = new FakeGate6Connection();
  await claimProtectedInstallBootstrapSlot(compensationConnection, slotInput);
  const compensated = await compensateProtectedInstallBootstrapSlot(compensationConnection, {
    operationId: slotInput.operationId,
    transferTokenSha256: slotInput.transferTokenSha256,
    expectedSlotVersion: 1,
    compensatedAt: "2026-07-11T01:00:20.000Z",
  });
  assert.deepEqual(compensated, { status: "released", slotVersion: 2, idempotent: false });
  assert.equal(compensationConnection.slot?.state, "released");
  assert.equal(compensationConnection.slot?.transfer_token_sha256, null);
  const compensatedAgain = await compensateProtectedInstallBootstrapSlot(compensationConnection, {
    operationId: slotInput.operationId,
    transferTokenSha256: slotInput.transferTokenSha256,
    expectedSlotVersion: 1,
    compensatedAt: "2026-07-11T01:00:20.000Z",
  });
  assert.deepEqual(compensatedAgain, { status: "released", slotVersion: 2, idempotent: true });
  const finalized = await finalizeProtectedInstallGate6Slot(connection, {
    ...slotInput,
    intentHeartbeatAt: slotInput.heartbeatAt,
    intentExpiresAt: slotInput.expiresAt,
    heartbeatAt: FINAL_HEARTBEAT_AT,
    expiresAt: FINAL_EXPIRES_AT,
    protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
    expectedSlotVersion: 1,
  });
  assert.deepEqual(finalized, { status: "installed-awaiting-gate6", slotVersion: 2, idempotent: false });
  assert.equal(connection.slot?.heartbeat_at, FINAL_HEARTBEAT_AT);
  assert.equal(connection.slot?.expires_at, FINAL_EXPIRES_AT);
  assert.ok(Date.parse(FINAL_HEARTBEAT_AT) > Date.parse(slotInput.heartbeatAt));
  const finalizedAgain = await finalizeProtectedInstallGate6Slot(connection, {
    ...slotInput,
    intentHeartbeatAt: slotInput.heartbeatAt,
    intentExpiresAt: slotInput.expiresAt,
    heartbeatAt: FINAL_HEARTBEAT_AT,
    expiresAt: FINAL_EXPIRES_AT,
    protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
    expectedSlotVersion: 1,
  });
  assert.deepEqual(finalizedAgain, { status: "installed-awaiting-gate6", slotVersion: 2, idempotent: true });
  assert.deepEqual(
    await inspectProtectedInstallSlot(connection, {
      operationId: slotInput.operationId,
      transferTokenSha256: slotInput.transferTokenSha256,
    }),
    { status: "installed-awaiting-gate6", slotVersion: 2 },
  );
  assert.deepEqual(
    await inspectProtectedInstallSlot(compensationConnection, {
      operationId: slotInput.operationId,
      transferTokenSha256: slotInput.transferTokenSha256,
    }),
    { status: "released", slotVersion: 2 },
  );

  assert.ok(connection.slot);
  connection.slot = {
    ...connection.slot,
    owner_type: "gate6",
    owner_id: "gate6-previous",
    operation_id: "deploy-previous",
    transfer_token_sha256: null,
    state: "released",
    version: 4,
  };
  const nextInstall = {
    ...slotInput,
    operationId: "deploy-101-1-production",
    transferTokenSha256: H("e"),
    installIntentEvidenceSha256: H("f"),
  };
  const reclaimed = await claimProtectedInstallBootstrapSlot(connection, nextInstall);
  assert.deepEqual(reclaimed, { status: "installing", slotVersion: 5, idempotent: false });
  assert.equal(connection.slot.owner_id, nextInstall.operationId);
  assert.equal(connection.slot.version, 5);

  connection.slot = { ...connection.slot, owner_type: "gate6", owner_id: "gate6-active", state: "active" };
  await assert.rejects(
    claimProtectedInstallBootstrapSlot(connection, { ...nextInstall, operationId: "deploy-blocked" }),
    /already owned|binding mismatched/,
  );
  connection.slot = null;

  const stateDir = await mkdtemp(join(tmpdir(), "spx-protected-handoff-"));
  try {
    await acquireInstallLock(stateDir);

    connection.slot = {
      environment: "production",
      owner_type: "gate6",
      owner_id: "gate6-previous",
      operation_id: "deploy-previous",
      transfer_token_sha256: null,
      state: "released",
      version: 9,
      uncompensated_work: 0,
      protected_install_evidence_sha256: H("a"),
      release_sha: "2".repeat(40),
      target_descriptor_sha256: H("b"),
      operator_bundle_sha256: H("c"),
      installed_migration_set_sha256: H("d"),
      installed_schema_version: 35,
      heartbeat_at: "2026-07-11T00:00:00.000Z",
      expires_at: "2026-07-11T00:00:00.000Z",
    };
    const beforeClaim = await reconcileProtectedInstallHandoffOnce({
      connection,
      stateDir,
      nowMs: START_MS + 5_000,
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(beforeClaim.outcome, "slot-not-yet-created");
    assert.equal(beforeClaim.lock.state, "installing");
    connection.slot = null;

    // Simulated process death: the DB transaction committed, but the process
    // exited before the separately fsynced host-lock transition.
    await claimProtectedInstallBootstrapSlot(connection, slotInput);
    assert.equal(connection.slot?.state, "installing");
    assert.equal((await readProductionMutationLock({ stateDir, allowNonRoot: true })).state, "installing");

    const bootstrapResumed = await reconcileProtectedInstallHandoffOnce({
      connection,
      stateDir,
      nowMs: START_MS + 10_000,
      watchdogOwner: "systemd:spx-protected-install-watchdog",
      leaseDurationMs: 60 * 60 * 1_000,
      allowNonRoot: true,
    });
    assert.equal(bootstrapResumed.outcome, "protected-install-bootstrap-reconciled");
    assert.equal(bootstrapResumed.lock.state, "installing");
    assert.equal(bootstrapResumed.lock.installBootstrap.transferTokenSha256, slotInput.transferTokenSha256);
    assert.equal(bootstrapResumed.lock.protectedInstall, null);

    await finalizeProtectedInstallGate6Slot(connection, {
      ...slotInput,
      intentHeartbeatAt: slotInput.heartbeatAt,
      intentExpiresAt: slotInput.expiresAt,
      heartbeatAt: FINAL_HEARTBEAT_AT,
      expiresAt: FINAL_EXPIRES_AT,
      protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
      expectedSlotVersion: 1,
    });
    assert.equal(connection.slot?.state, "installed-awaiting-gate6");
    assert.equal(
      (await readProductionMutationLock({ stateDir, allowNonRoot: true })).state,
      "installing",
      "a final-slot commit crash must remain fail-closed until host reconciliation",
    );
    const resumed = await reconcileProtectedInstallHandoffOnce({
      connection,
      stateDir,
      allowNonRoot: true,
      preparedCommit: {
        databaseSlot: preparedDatabaseCommit,
        hostLock: preparedHostCommit,
      },
    });
    assert.equal(resumed.outcome, "prepared-protected-install-commit-reconciled");
    assert.equal(resumed.lock.state, "installed-awaiting-gate6");
    assert.equal(resumed.lock.lease.owner, "systemd:spx-protected-install-watchdog");
    assert.equal(resumed.lock.protectedInstall.transferTokenSha256, slotInput.transferTokenSha256);
    assert.equal(resumed.lock.protectedInstall.protectedInstallEvidenceSha256, FINAL_EVIDENCE_SHA256);
    assert.equal(resumed.lock.protectedInstall.slotVersion, 2);

    const finalBinding = {
      operationId: slotInput.operationId,
      transferTokenSha256: slotInput.transferTokenSha256,
      protectedInstallEvidenceSha256: FINAL_EVIDENCE_SHA256,
      releaseSha: slotInput.releaseSha,
      targetDescriptorSha256: slotInput.targetDescriptorSha256,
      operatorBundleSha256: slotInput.operatorBundleSha256,
      installedMigrationSetSha256: slotInput.installedMigrationSetSha256,
      installedSchemaVersion: slotInput.installedSchemaVersion,
      heartbeatAt: FINAL_HEARTBEAT_AT,
      expiresAt: FINAL_EXPIRES_AT,
      slotVersion: 2,
    };

    const idempotentHost = await markProductionInstallAwaitingGate6({
      ...hostIdentity(stateDir, "systemd:spx-protected-install-watchdog"),
      binding: finalBinding,
    });
    assert.equal(idempotentHost.revision, resumed.lock.revision);
    const racedWorkflowConfirmation = await markProductionInstallAwaitingGate6({
      ...hostIdentity(stateDir),
      binding: finalBinding,
    });
    assert.equal(racedWorkflowConfirmation.revision, resumed.lock.revision);

    await assert.rejects(
      markProductionMutationTerminal({
        ...hostIdentity(stateDir, "systemd:spx-protected-install-watchdog"),
        terminalPostcondition: { kind: "healthy-baseline", hash: H("d") },
      }),
      /protected-install-handoff-required/,
    );

    const pending = await beginProductionMutationGate6Handoff({
      ...hostIdentity(stateDir, "systemd:spx-protected-install-watchdog"),
      gate6Id: "gate6-production-001",
      transferTokenSha256: slotInput.transferTokenSha256,
      expectedSlotVersion: 2,
    });
    assert.equal(pending.state, "handoff-pending");
    assert.equal(existsSync(join(stateDir, "lock.json")), true);

    const heldPending = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 20_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(heldPending.outcome, "held");
    assert.equal(heldPending.lock.state, "handoff-pending");

    let queriedTargetDescriptorSha256 = "";
    await assert.rejects(
      reconcileProtectedInstallHandoffOnce({
        readSlot: async ({ targetDescriptorSha256 }: { targetDescriptorSha256: string }) => {
          queriedTargetDescriptorSha256 = targetDescriptorSha256;
          throw new Error("transient-query-failure");
        },
        stateDir,
        nowMs: START_MS + 21_000,
        allowNonRoot: true,
      }),
      /transient-query-failure/,
    );
    assert.equal(queriedTargetDescriptorSha256, slotInput.targetDescriptorSha256);
    assert.equal(
      (await readProductionMutationLock({ stateDir, allowNonRoot: true })).state,
      "handoff-pending",
      "a transient query failure must preserve the durable handoff fence",
    );

    const reversed = await reconcileProtectedInstallHandoffOnce({
      connection,
      stateDir,
      nowMs: START_MS + 22_000,
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(reversed.outcome, "install-owner-restored");
    assert.equal(reversed.lock.state, "installed-awaiting-gate6");
    assert.equal(reversed.lock.handoff, null);

    await reconcileProtectedInstallHandoffOnce({
      connection,
      stateDir,
      nowMs: START_MS + 23_000,
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });

    await beginProductionMutationGate6Handoff({
      ...hostIdentity(stateDir, "systemd:spx-protected-install-watchdog"),
      gate6Id: "gate6-production-001",
      transferTokenSha256: slotInput.transferTokenSha256,
      expectedSlotVersion: 2,
    });
    connection.transferToGate6("gate6-production-001");
    const completed = await reconcileProductionMutationGate6Handoff({
      ...hostIdentity(stateDir, "systemd:spx-protected-install-watchdog"),
      observedSlot: structuredClone(connection.slot),
      gate6LeaseOwner: "systemd:gate6-supervisor",
      gate6LeaseDurationMs: 30_000,
    });
    assert.equal(completed.outcome, "gate6-owner-completed");
    assert.equal(completed.lock.state, "gate6-active");
    assert.equal(completed.lock.handoff.slotVersion, 3);
    assert.equal(completed.lock.lease.owner, "systemd:gate6-supervisor");
    assert.equal(existsSync(join(stateDir, "lock.json")), true, "Gate 6 handoff never clears the host lock");

    const held = await reconcileProductionMutationLock({
      stateDir,
      nowMs: START_MS + 20_000,
      reconcilerOwner: "systemd:spx-production-mutation-reconciler",
      leaseDurationMs: 30_000,
      allowNonRoot: true,
    });
    assert.equal(held.outcome, "held");
    assert.equal(existsSync(join(stateDir, "lock.json")), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  const automaticStateDir = await mkdtemp(join(tmpdir(), "spx-protected-auto-state-"));
  const automaticPreparedRoot = await mkdtemp(join(tmpdir(), "spx-protected-auto-record-"));
  try {
    const automatic = new FakeGate6Connection();
    await prepareInstallOwners(automaticStateDir, automatic);
    const fixedEvidenceSha256 = await writeFixedPreparedCommit(automaticPreparedRoot);
    await commitProtectedInstallGate6Slot(automatic, {
      ...preparedDatabaseCommit,
      protectedInstallEvidenceSha256: fixedEvidenceSha256,
    });
    assert.equal(automatic.slot?.state, "installed-awaiting-gate6");
    assert.equal(
      (await readProductionMutationLock({ stateDir: automaticStateDir, allowNonRoot: true })).state,
      "installing",
      "the fixed-record loader must recover a slot-first partial CAS",
    );
    const unexpectedPreparedFile = join(
      automaticPreparedRoot,
      "prepared",
      slotInput.operationId,
      "unexpected.json",
    );
    await writeFile(unexpectedPreparedFile, "{}", { encoding: "utf8", mode: 0o400 });
    await assert.rejects(
      reconcileProtectedInstallHandoffOnce({
        connection: automatic,
        stateDir: automaticStateDir,
        allowNonRoot: true,
        testOnlyProtectedInstallRoot: automaticPreparedRoot,
      }),
      /file set|incomplete/i,
    );
    assert.equal(automatic.slot?.state, "installed-awaiting-gate6");
    assert.equal(
      (await readProductionMutationLock({ stateDir: automaticStateDir, allowNonRoot: true })).state,
      "installing",
    );
    await rm(unexpectedPreparedFile, { force: true });
    const recovered = await reconcileProtectedInstallHandoffOnce({
      connection: automatic,
      stateDir: automaticStateDir,
      allowNonRoot: true,
      testOnlyProtectedInstallRoot: automaticPreparedRoot,
    });
    assert.equal(recovered.outcome, "prepared-protected-install-commit-reconciled");
    assert.equal(automatic.slot?.state, "installed-awaiting-gate6");
    assert.equal(automatic.slot?.protected_install_evidence_sha256, fixedEvidenceSha256);
    const automaticLock = await readProductionMutationLock({
      stateDir: automaticStateDir,
      allowNonRoot: true,
    });
    assert.equal(automaticLock.state, "installed-awaiting-gate6");
    assert.equal(automaticLock.protectedInstall.protectedInstallEvidenceSha256, fixedEvidenceSha256);
    assert.equal(automaticLock.lease.heartbeatAt, FINAL_HEARTBEAT_AT);
    assert.equal(automaticLock.lease.expiresAt, FINAL_EXPIRES_AT);
  } finally {
    await rm(automaticStateDir, { recursive: true, force: true });
    await rm(automaticPreparedRoot, { recursive: true, force: true });
  }

  const automaticLockStateDir = await mkdtemp(join(tmpdir(), "spx-protected-auto-lock-state-"));
  const automaticLockPreparedRoot = await mkdtemp(join(tmpdir(), "spx-protected-auto-lock-record-"));
  try {
    const automaticLock = new FakeGate6Connection();
    await prepareInstallOwners(automaticLockStateDir, automaticLock);
    const fixedEvidenceSha256 = await writeFixedPreparedCommit(automaticLockPreparedRoot);
    await commitProductionInstallHostLock({
      stateDir: automaticLockStateDir,
      allowNonRoot: true,
      binding: {
        ...preparedHostCommit,
        protectedInstallEvidenceSha256: fixedEvidenceSha256,
      },
    });
    assert.equal(automaticLock.slot?.state, "installing");
    const recovered = await reconcileProtectedInstallHandoffOnce({
      connection: automaticLock,
      stateDir: automaticLockStateDir,
      allowNonRoot: true,
      testOnlyProtectedInstallRoot: automaticLockPreparedRoot,
    });
    assert.equal(recovered.outcome, "prepared-protected-install-commit-reconciled");
    assert.equal(automaticLock.slot?.state, "installed-awaiting-gate6");
    assert.equal(automaticLock.slot?.protected_install_evidence_sha256, fixedEvidenceSha256);
    assert.equal(recovered.lock.protectedInstall.protectedInstallEvidenceSha256, fixedEvidenceSha256);
  } finally {
    await rm(automaticLockStateDir, { recursive: true, force: true });
    await rm(automaticLockPreparedRoot, { recursive: true, force: true });
  }

  const slotFirstStateDir = await mkdtemp(join(tmpdir(), "spx-protected-slot-first-"));
  try {
    const slotFirst = new FakeGate6Connection();
    await prepareInstallOwners(slotFirstStateDir, slotFirst);
    await assert.rejects(
      reconcileProtectedInstallHandoffOnce({
        connection: slotFirst,
        stateDir: slotFirstStateDir,
        allowNonRoot: true,
        preparedCommit: {
          databaseSlot: preparedDatabaseCommit,
          hostLock: { ...preparedHostCommit, expectedNextVersion: 4 },
        },
      }),
      /prepared|binding|version|invalid/i,
    );
    assert.equal(slotFirst.slot?.state, "installing");
    assert.equal(
      (await readProductionMutationLock({ stateDir: slotFirstStateDir, allowNonRoot: true })).state,
      "installing",
      "an invalid prepared record authorizes no first CAS",
    );
    await commitProtectedInstallGate6Slot(slotFirst, preparedDatabaseCommit);
    assert.equal(slotFirst.slot?.state, "installed-awaiting-gate6");
    assert.equal(
      (await readProductionMutationLock({ stateDir: slotFirstStateDir, allowNonRoot: true })).state,
      "installing",
      "slot-first recovery must keep the host owner blocking",
    );

    await assert.rejects(
      reconcileProtectedInstallHandoffOnce({
        connection: slotFirst,
        stateDir: slotFirstStateDir,
        allowNonRoot: true,
        preparedCommit: {
          databaseSlot: preparedDatabaseCommit,
          hostLock: { ...preparedHostCommit, protectedInstallEvidenceSha256: H("e") },
        },
      }),
      /prepared|binding|mismatch|conflict/i,
    );
    assert.equal(
      (await readProductionMutationLock({ stateDir: slotFirstStateDir, allowNonRoot: true })).state,
      "installing",
      "a mismatched prepared hash must not opportunistically finalize or clear the host lock",
    );

    const recovered = await reconcileProtectedInstallHandoffOnce({
      connection: slotFirst,
      stateDir: slotFirstStateDir,
      allowNonRoot: true,
      preparedCommit: {
        databaseSlot: preparedDatabaseCommit,
        hostLock: preparedHostCommit,
      },
    });
    assert.equal(recovered.outcome, "prepared-protected-install-commit-reconciled");
    assert.equal(recovered.lock.state, "installed-awaiting-gate6");
    assert.equal(recovered.lock.revision, 3);
    assert.equal(recovered.lock.protectedInstall.protectedInstallEvidenceSha256, FINAL_EVIDENCE_SHA256);
    assert.equal(recovered.lock.lease.heartbeatAt, FINAL_HEARTBEAT_AT);
    assert.equal(recovered.lock.lease.expiresAt, FINAL_EXPIRES_AT);
    assert.equal(existsSync(join(slotFirstStateDir, "lock.json")), true);
  } finally {
    await rm(slotFirstStateDir, { recursive: true, force: true });
  }

  const lockFirstStateDir = await mkdtemp(join(tmpdir(), "spx-protected-lock-first-"));
  try {
    const lockFirst = new FakeGate6Connection();
    await prepareInstallOwners(lockFirstStateDir, lockFirst);
    await commitProductionInstallHostLock({
      stateDir: lockFirstStateDir,
      allowNonRoot: true,
      binding: preparedHostCommit,
    });
    assert.equal(lockFirst.slot?.state, "installing");
    assert.equal(
      (await readProductionMutationLock({ stateDir: lockFirstStateDir, allowNonRoot: true })).state,
      "installed-awaiting-gate6",
      "lock-first recovery must keep the host owner blocking",
    );
    await assert.rejects(
      acquireProductionMutationLock({
        stateDir: lockFirstStateDir,
        allowNonRoot: true,
        nowMs: START_MS + 20_000,
        request: {
          operationId: "deploy-other-production",
          operationType: "install",
          releaseHash: H("d"),
          targetHash: H("e"),
          state: "installing",
          rollbackJournalHash: H("6"),
          rollbackIdentity: {
            project: "spx-production",
            releaseHash: H("7"),
            imageDigest: `sha256:${H("8")}`,
            serviceSetHash: H("9"),
            configHash: H("c"),
          },
          lease: { owner: "workflow:other", durationMs: 60_000 },
        },
      }),
      /held/,
    );

    await assert.rejects(
      reconcileProtectedInstallHandoffOnce({
        connection: lockFirst,
        stateDir: lockFirstStateDir,
        allowNonRoot: true,
        preparedCommit: {
          databaseSlot: { ...preparedDatabaseCommit, expectedNextVersion: 3 },
          hostLock: preparedHostCommit,
        },
      }),
      /prepared|binding|version|mismatch|invalid/i,
    );
    assert.equal(lockFirst.slot?.state, "installing");
    assert.equal(lockFirst.slot?.version, 1);

    const recovered = await reconcileProtectedInstallHandoffOnce({
      connection: lockFirst,
      stateDir: lockFirstStateDir,
      allowNonRoot: true,
      preparedCommit: {
        databaseSlot: preparedDatabaseCommit,
        hostLock: preparedHostCommit,
      },
    });
    assert.equal(recovered.outcome, "prepared-protected-install-commit-reconciled");
    assert.equal(lockFirst.slot?.state, "installed-awaiting-gate6");
    assert.equal(lockFirst.slot?.protected_install_evidence_sha256, FINAL_EVIDENCE_SHA256);
    assert.equal(recovered.lock.revision, 3);
    assert.equal(existsSync(join(lockFirstStateDir, "lock.json")), true);
  } finally {
    await rm(lockFirstStateDir, { recursive: true, force: true });
  }
}

void main();
