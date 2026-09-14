import assert from "node:assert/strict";

import {
  commitProtectedInstallGate6Slot,
  previewProtectedInstallGate6SlotCommit,
  readProtectedInstallGate6SlotCommit,
} from "../scripts/protected-install-watchdog.mjs";

const H = (character: string): string => character.repeat(64);
const OPERATION_ID = "deploy-100-1-production";
const RELEASE_SHA = "1".repeat(40);
const HEARTBEAT_AT = "2026-07-11T01:10:10.000Z";
const EXPIRES_AT = "2026-07-12T01:10:10.000Z";
const EVIDENCE_SHA256 = H("f");

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

const identity = {
  operationId: OPERATION_ID,
  releaseSha: RELEASE_SHA,
  targetDescriptorSha256: H("b"),
  operatorBundleSha256: H("4"),
  installedMigrationSetSha256: H("5"),
  installedSchemaVersion: 36,
} as const;

function finalBinding(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    protectedInstallEvidenceSha256: EVIDENCE_SHA256,
    heartbeatAt: HEARTBEAT_AT,
    expiresAt: EXPIRES_AT,
    expectedCurrentVersion: 7,
    expectedNextVersion: 8,
    ...overrides,
  };
}

class FakePreparedSlotConnection {
  slot: SlotRow;
  private transactionSlot: SlotRow | null = null;
  commits = 0;
  rollbacks = 0;

  constructor() {
    this.slot = {
      environment: "production",
      owner_type: "protected-install",
      owner_id: OPERATION_ID,
      operation_id: OPERATION_ID,
      transfer_token_sha256: H("2"),
      state: "installing",
      version: 7,
      uncompensated_work: 0,
      protected_install_evidence_sha256: H("3"),
      release_sha: RELEASE_SHA,
      target_descriptor_sha256: identity.targetDescriptorSha256,
      operator_bundle_sha256: identity.operatorBundleSha256,
      installed_migration_set_sha256: identity.installedMigrationSetSha256,
      installed_schema_version: identity.installedSchemaVersion,
      heartbeat_at: "2026-07-11T01:00:10.000Z",
      expires_at: "2026-07-11T02:00:10.000Z",
    };
  }

  async beginTransaction(): Promise<void> {
    this.transactionSlot = structuredClone(this.slot);
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<[unknown, unknown]> {
    if (/SELECT[\s\S]+FROM gate6_environment_slots/i.test(sql)) {
      const selected = /FOR UPDATE/i.test(sql) ? this.transactionSlot : this.slot;
      return [[structuredClone(selected)], []];
    }
    if (/UPDATE gate6_environment_slots[\s\S]+installed-awaiting-gate6/i.test(sql)) {
      const row = this.transactionSlot;
      if (
        row === null
        || row.state !== "installing"
        || row.operation_id !== String(parameters[4])
        || row.owner_id !== String(parameters[5])
        || row.release_sha !== String(parameters[6])
        || row.target_descriptor_sha256 !== String(parameters[7])
        || row.operator_bundle_sha256 !== String(parameters[8])
        || row.installed_migration_set_sha256 !== String(parameters[9])
        || row.installed_schema_version !== Number(parameters[10])
        || row.version !== Number(parameters[11])
      ) return [{ affectedRows: 0 }, []];
      this.transactionSlot = {
        ...row,
        state: "installed-awaiting-gate6",
        version: row.version + 1,
        protected_install_evidence_sha256: String(parameters[0]),
        heartbeat_at: String(parameters[1]),
        expires_at: String(parameters[2]),
      };
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async commit(): Promise<void> {
    assert.ok(this.transactionSlot);
    this.slot = structuredClone(this.transactionSlot);
    this.transactionSlot = null;
    this.commits += 1;
  }

  async rollback(): Promise<void> {
    this.transactionSlot = null;
    this.rollbacks += 1;
  }
}

async function main(): Promise<void> {
  const connection = new FakePreparedSlotConnection();
  assert.deepEqual(
    await previewProtectedInstallGate6SlotCommit(connection, identity),
    {
      current: { operationId: OPERATION_ID, state: "installing", version: 7 },
      next: { operationId: OPERATION_ID, state: "installed-awaiting-gate6", version: 8 },
    },
  );
  assert.deepEqual(
    await readProtectedInstallGate6SlotCommit(connection, finalBinding()),
    {
      operationId: OPERATION_ID,
      state: "installing",
      version: 7,
      protectedInstallEvidenceSha256: H("3"),
      heartbeatAt: "2026-07-11T01:00:10.000Z",
      expiresAt: "2026-07-11T02:00:10.000Z",
      releaseSha: RELEASE_SHA,
      targetDescriptorSha256: identity.targetDescriptorSha256,
      operatorBundleSha256: identity.operatorBundleSha256,
      installedMigrationSetSha256: identity.installedMigrationSetSha256,
      installedSchemaVersion: identity.installedSchemaVersion,
    },
  );

  assert.deepEqual(
    await commitProtectedInstallGate6Slot(connection, finalBinding()),
    { status: "installed-awaiting-gate6", slotVersion: 8, idempotent: false },
  );
  assert.deepEqual(
    await readProtectedInstallGate6SlotCommit(connection, finalBinding()),
    {
      operationId: OPERATION_ID,
      state: "installed-awaiting-gate6",
      version: 8,
      protectedInstallEvidenceSha256: EVIDENCE_SHA256,
      heartbeatAt: HEARTBEAT_AT,
      expiresAt: EXPIRES_AT,
      releaseSha: RELEASE_SHA,
      targetDescriptorSha256: identity.targetDescriptorSha256,
      operatorBundleSha256: identity.operatorBundleSha256,
      installedMigrationSetSha256: identity.installedMigrationSetSha256,
      installedSchemaVersion: identity.installedSchemaVersion,
    },
  );
  assert.deepEqual(
    await commitProtectedInstallGate6Slot(connection, finalBinding()),
    { status: "installed-awaiting-gate6", slotVersion: 8, idempotent: true },
  );

  for (const changed of [
    { protectedInstallEvidenceSha256: H("e") },
    { heartbeatAt: "2026-07-11T01:10:11.000Z" },
    { expiresAt: "2026-07-12T01:10:11.000Z" },
    { expectedCurrentVersion: 8, expectedNextVersion: 9 },
    { releaseSha: "2".repeat(40) },
    { targetDescriptorSha256: H("c") },
    { operatorBundleSha256: H("6") },
    { installedMigrationSetSha256: H("7") },
    { installedSchemaVersion: 37 },
  ]) {
    await assert.rejects(
      commitProtectedInstallGate6Slot(connection, finalBinding(changed)),
      /prepared commit|binding|version|identity|mismatch|lease|invalid/i,
    );
  }

  const fresh = new FakePreparedSlotConnection();
  await assert.rejects(
    commitProtectedInstallGate6Slot(fresh, finalBinding({ expectedNextVersion: 9 })),
    /version/i,
  );
  assert.equal(fresh.slot.state, "installing");
  assert.equal(fresh.slot.version, 7);

  const expired = new FakePreparedSlotConnection();
  expired.slot = {
    ...expired.slot,
    expires_at: "2026-07-11T01:05:00.000Z",
  };
  await assert.rejects(
    commitProtectedInstallGate6Slot(expired, finalBinding()),
    /lease|binding|expired/i,
  );
  assert.equal(expired.slot.state, "installing");
  assert.equal(expired.slot.version, 7);

  fresh.slot = { ...fresh.slot, state: "active", owner_type: "gate6" };
  await assert.rejects(
    previewProtectedInstallGate6SlotCommit(fresh, identity),
    /installing|binding/i,
  );
}

void main();
