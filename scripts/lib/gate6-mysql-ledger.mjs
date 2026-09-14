import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP } from "node:net";

import mysql from "mysql2/promise";

const CONTAINER_PASSWORD_FILE = "/run/secrets/db_password";
const CONTAINER_CA_FILE = "/run/config/db-ca.pem";
const HOST_CAPABILITY_FILE = "/var/lib/spx-gate6/gate6-control-db.json";
const HOST_PASSWORD_FILE = "/var/lib/spx-gate6/secrets/gate6-control-db-password";
const HOST_CA_FILE = "/var/lib/spx-gate6/config/db-ca.pem";
const HOST_PHASE3_CAPABILITY_FILE = "/var/lib/spx-gate6/phase3-control-db.json";
const HOST_PHASE3_PASSWORD_FILE = "/var/lib/spx-gate6/secrets/phase3-control-db-password";
const receipts = new WeakSet();
const task9Receipts = new WeakSet();
const DNS_NAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;

function one(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error(`${label} is missing or ambiguous`);
  return rows[0];
}

function affectedOne(result, label) {
  if (result?.affectedRows !== 1) throw new Error(`${label} compare-and-swap failed`);
}

function hash(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} is invalid`);
}

function time(value, label) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function assertExactAction(row, input) {
  if (
    row.gate6_id !== input.gate6Id ||
    row.scope !== input.scope ||
    row.action_id !== input.actionId ||
    row.approval_sha256 !== input.approvalSha256 ||
    row.allowed_mutation_sha256 !== input.allowedMutationSha256
  )
    throw new Error("Gate 6 action identity/hash mismatch");
}

async function transaction(pool, callback) {
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateProductionGate6DbCapability(value, expectedTargetDescriptorSha256) {
  if (
    !exactObject(value, [
      "schemaVersion",
      "host",
      "port",
      "database",
      "username",
      "sslServername",
      "targetDescriptorSha256",
      "passwordSha256",
      "caSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    value.host.length > 253 ||
    !Number.isSafeInteger(value.port) ||
    value.port <= 0 ||
    value.port > 65_535 ||
    value.database !== "spx" ||
    !/^[A-Za-z0-9_$-]{1,64}$/.test(value.username ?? "") ||
    !DNS_NAME.test(value.sslServername ?? "") ||
    isIP(value.sslServername) !== 0 ||
    !/^[0-9a-f]{64}$/.test(value.targetDescriptorSha256 ?? "") ||
    value.targetDescriptorSha256 !== expectedTargetDescriptorSha256 ||
    !/^[0-9a-f]{64}$/.test(value.passwordSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(value.caSha256 ?? "")
  )
    throw new Error("production Gate 6 database capability is invalid");
  return Object.freeze({
    host: value.host,
    port: value.port,
    database: "spx",
    username: value.username,
    sslServername: value.sslServername,
    passwordSha256: value.passwordSha256,
    caSha256: value.caSha256,
  });
}

async function readSecureFile(path, { maximumBytes, rootPrivate }) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes) ||
    (process.platform !== "win32" && before.uid !== 0n) ||
    (process.platform !== "win32" && rootPrivate && Number(before.mode & 0o077n) !== 0) ||
    (process.platform !== "win32" && !rootPrivate && Number(before.mode & 0o022n) !== 0)
  )
    throw new Error("Gate 6 database capability file is insecure");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Gate 6 database capability file changed");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      throw new Error("Gate 6 database capability file changed");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function loadDatabaseCapability(input) {
  if (input.runtime === "container") {
    const value = {
      schemaVersion: 1,
      host: process.env.DB_HOST,
      port: Number.parseInt(process.env.DB_PORT ?? "3306", 10),
      database: process.env.DB_NAME,
      username: process.env.SPX_DB_USERNAME_GATE6_CONTROL,
      sslServername: process.env.DB_SSL_SERVERNAME,
      targetDescriptorSha256: input.expectedTargetDescriptorSha256,
      passwordSha256: process.env.SPX_GATE6_DB_PASSWORD_SHA256,
      caSha256: process.env.SPX_GATE6_DB_CA_SHA256,
    };
    if (process.env.DB_SSL_MODE !== "verify-identity") {
      throw new Error("Gate 6 database TLS verification is required");
    }
    return {
      config: validateProductionGate6DbCapability(value, input.expectedTargetDescriptorSha256),
      passwordFile: CONTAINER_PASSWORD_FILE,
      caFile: CONTAINER_CA_FILE,
      rootPrivate: false,
    };
  }
  if (input.runtime !== "host") throw new Error("unknown Gate 6 database capability runtime");
  const bytes = await readSecureFile(HOST_CAPABILITY_FILE, {
    maximumBytes: 16 * 1024,
    rootPrivate: true,
  });
  const value = JSON.parse(bytes.toString("utf8"));
  return {
    config: validateProductionGate6DbCapability(value, input.expectedTargetDescriptorSha256),
    passwordFile: HOST_PASSWORD_FILE,
    caFile: HOST_CA_FILE,
    rootPrivate: true,
  };
}

export async function createProductionGate6MysqlPool(input = {}) {
  const capability = await loadDatabaseCapability({
    runtime: input.runtime ?? "host",
    expectedTargetDescriptorSha256: input.expectedTargetDescriptorSha256,
  });
  const [passwordBytes, ca] = await Promise.all([
    readSecureFile(capability.passwordFile, {
      maximumBytes: 16 * 1024,
      rootPrivate: capability.rootPrivate,
    }),
    readSecureFile(capability.caFile, {
      maximumBytes: 1024 * 1024,
      rootPrivate: capability.rootPrivate,
    }),
  ]);
  const password = passwordBytes.toString("utf8").trim();
  if (
    createHash("sha256").update(passwordBytes).digest("hex") !== capability.config.passwordSha256 ||
    createHash("sha256").update(ca).digest("hex") !== capability.config.caSha256 ||
    !/^[A-Za-z0-9_-]{32,1024}$/.test(password) ||
    !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca.toString("utf8"))
  )
    throw new Error("Gate 6 database credential or CA binding is invalid");
  return createProductionPool(capability.config, password, ca);
}

function createProductionPool(config, password, ca) {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password,
    ssl: {
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: config.sslServername,
    },
    connectionLimit: 2,
    waitForConnections: true,
    queueLimit: 0,
    timezone: "Z",
    multipleStatements: false,
  });
}

export async function createProductionPhase3ControlMysqlPool(input = {}) {
  const capabilityBytes = await readSecureFile(HOST_PHASE3_CAPABILITY_FILE, {
    maximumBytes: 16 * 1024,
    rootPrivate: true,
  });
  const config = validateProductionGate6DbCapability(
    JSON.parse(capabilityBytes.toString("utf8")),
    input.expectedTargetDescriptorSha256,
  );
  if (!/^spx[_-]phase3[_-]control(?:[_-][A-Za-z0-9]+)*$/i.test(config.username)) {
    throw new Error("production Phase 3 control principal is invalid");
  }
  const [passwordBytes, ca] = await Promise.all([
    readSecureFile(HOST_PHASE3_PASSWORD_FILE, { maximumBytes: 16 * 1024, rootPrivate: true }),
    readSecureFile(HOST_CA_FILE, { maximumBytes: 1024 * 1024, rootPrivate: true }),
  ]);
  const password = passwordBytes.toString("utf8").trim();
  if (
    createHash("sha256").update(passwordBytes).digest("hex") !== config.passwordSha256 ||
    createHash("sha256").update(ca).digest("hex") !== config.caSha256 ||
    !/^[A-Za-z0-9_-]{32,1024}$/.test(password) ||
    !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca.toString("utf8"))
  )
    throw new Error("Phase 3 control database credential or CA binding is invalid");
  return createProductionPool(config, password, ca);
}

export function createGate6MysqlLedger(pool) {
  async function revokeLocked(connection, gate6Id, reasonCode, at) {
    const [run] = await connection.execute(
      `
      UPDATE gate6_runs
      SET status = 'revoked', revocation_reason_code = ?, updated_at = ?
      WHERE gate6_id = ? AND status IN ('active', 'sealed-verifying', 'releasing')
    `,
      [reasonCode, at, gate6Id],
    );
    affectedOne(run, "Gate 6 revocation");
    const [slot] = await connection.execute(
      `
      UPDATE gate6_environment_slots
      SET state = 'revoked-uncompensated', uncompensated_work = 1,
          heartbeat_at = ?, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
        AND state IN ('active', 'sealed-verifying', 'releasing')
    `,
      [at, at, gate6Id],
    );
    affectedOne(slot, "Gate 6 revoked slot");
  }

  async function clearUncompensatedIfSafe(connection, gate6Id, at) {
    const [unsafeRows] = await connection.execute(
      `
      SELECT COUNT(*) AS count FROM gate6_actions
      WHERE gate6_id = ? AND status IN ('consumed', 'failed', 'ambiguous')
    `,
      [gate6Id],
    );
    const unsafe = one(unsafeRows, "Gate 6 unsafe action count");
    const [permitRows] = await connection.execute(
      `
      SELECT COUNT(*) AS count FROM gate6_fault_permits
      WHERE gate6_id = ? AND status = 'armed'
    `,
      [gate6Id],
    );
    const permits = one(permitRows, "Gate 6 armed permit count");
    if (Number(unsafe.count) !== 0 || Number(permits.count) !== 0) return;
    const [slot] = await connection.execute(
      `
      UPDATE gate6_environment_slots
      SET uncompensated_work = 0, heartbeat_at = ?, version = version + 1, updated_at = ?
      WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
        AND uncompensated_work = 1
    `,
      [at, at, gate6Id],
    );
    affectedOne(slot, "Gate 6 safe slot");
  }

  async function admitInstalledRun(input) {
    for (const [value, label] of [
      [input.envelopeSha256, "envelope hash"],
      [input.envelopeCoreSha256, "envelope core hash"],
      [input.productionTargetDescriptorSha256, "target descriptor hash"],
      [input.operatorBundleSha256, "operator bundle hash"],
      [input.protectedInstallEvidenceSha256, "protected install evidence hash"],
      [input.installedMigrationSetSha256, "installed migration set hash"],
      [input.transferTokenSha256, "transfer token hash"],
    ])
      hash(value, `Gate 6 admission ${label}`);
    if (
      input.releaseEnvironment !== "production" ||
      input.runtimeEnvironment !== "production" ||
      input.drillMode !== "supervised-production" ||
      input.composeProject !== "spx-production"
    )
      throw new Error("Gate 6 production admission discriminator mismatch");
    if (
      !/^[0-9a-f]{40}$/.test(input.candidateSha ?? "") ||
      !/^[0-9a-f]{40}$/.test(input.rollbackSha ?? "")
    ) {
      throw new Error("Gate 6 admission release SHA is invalid");
    }
    if (
      !/^sha256:[0-9a-f]{64}$/.test(input.candidateImageDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(input.rollbackImageDigest ?? "")
    )
      throw new Error("Gate 6 admission image digest is invalid");
    if (!Number.isSafeInteger(input.installedSchemaVersion) || input.installedSchemaVersion <= 0) {
      throw new Error("Gate 6 installed schema version is invalid");
    }
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
      throw new Error("Gate 6 signed action index is empty");
    }
    const actionIds = new Set();
    const admitAction = input.actions.find((action) => action.actionId === input.admitActionId);
    if (!admitAction || admitAction.scope !== "gate6-admit" || admitAction.kind !== "forward") {
      throw new Error("Gate 6 admission action is missing");
    }
    for (const action of input.actions) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.scope ?? "") ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.actionId ?? "") ||
        !["forward", "compensation", "emergency"].includes(action.kind) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(action.requiredStage ?? "")
      )
        throw new Error("Gate 6 admission action identity is invalid");
      if (actionIds.has(action.actionId)) throw new Error("Gate 6 signed action ID is duplicated");
      actionIds.add(action.actionId);
      hash(action.approvalSha256, "Gate 6 action approval hash");
      hash(action.allowedMutationSha256, "Gate 6 action mutation hash");
      if (action.requiredCheckerSha256 !== null)
        hash(action.requiredCheckerSha256, "Gate 6 checker hash");
      if (!Array.isArray(action.predecessorActionIds))
        throw new Error("Gate 6 action predecessors are invalid");
      time(action.expiresAt, "Gate 6 action expiry");
    }
    for (const action of input.actions) {
      if (action.predecessorActionIds.some((actionId) => !actionIds.has(actionId))) {
        throw new Error("Gate 6 action predecessor is not indexed");
      }
    }
    const now = input.now ?? new Date();
    const at = now.toISOString();
    return transaction(pool, async (connection) => {
      const [slotRows] = await connection.execute(`
        SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
               state, version, protected_install_evidence_sha256, release_sha,
               target_descriptor_sha256, operator_bundle_sha256,
               installed_migration_set_sha256, installed_schema_version,
               heartbeat_at, expires_at
        FROM gate6_environment_slots
        WHERE environment = 'production'
        FOR UPDATE
      `);
      const slot = one(slotRows, "installed-awaiting-gate6 production slot");
      if (
        slot.environment !== "production" ||
        slot.owner_type !== "protected-install" ||
        slot.owner_id !== input.installOperationId ||
        slot.operation_id !== input.installOperationId ||
        slot.transfer_token_sha256 !== input.transferTokenSha256 ||
        slot.state !== "installed-awaiting-gate6" ||
        slot.protected_install_evidence_sha256 !== input.protectedInstallEvidenceSha256 ||
        slot.release_sha !== input.candidateSha ||
        slot.target_descriptor_sha256 !== input.productionTargetDescriptorSha256 ||
        slot.operator_bundle_sha256 !== input.operatorBundleSha256 ||
        slot.installed_migration_set_sha256 !== input.installedMigrationSetSha256 ||
        Number(slot.installed_schema_version) !== input.installedSchemaVersion ||
        time(slot.expires_at, "protected-install slot expiry") <= now.getTime()
      )
        throw new Error("installed-awaiting-gate6 slot transfer binding mismatch");
      const [run] = await connection.execute(
        `
        INSERT INTO gate6_runs (
          gate6_id, gate6_nonce, envelope_sha256, envelope_core_sha256,
          release_environment, runtime_environment, drill_mode, compose_project,
          candidate_sha, candidate_image_digest, rollback_sha, rollback_image_digest,
          production_target_descriptor_sha256, operator_bundle_sha256,
          protected_install_evidence_sha256, installed_migration_set_sha256,
          installed_schema_version, status, current_stage, stage_version,
          accepted_checker_name, accepted_checker_sha256, revocation_reason_code,
          monitor_status, monitor_lease_expires_at,
          supervisor_status, supervisor_lease_expires_at,
          emergency_supervisor_lease_expires_at, terminal_evidence_sha256,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'active', 'admitted', 1, NULL, NULL, NULL,
                  'green', ?, 'green', ?, ?, NULL, ?, ?, ?)
      `,
        [
          input.gate6Id,
          input.gate6Nonce,
          input.envelopeSha256,
          input.envelopeCoreSha256,
          input.releaseEnvironment,
          input.runtimeEnvironment,
          input.drillMode,
          input.composeProject,
          input.candidateSha,
          input.candidateImageDigest,
          input.rollbackSha,
          input.rollbackImageDigest,
          input.productionTargetDescriptorSha256,
          input.operatorBundleSha256,
          input.protectedInstallEvidenceSha256,
          input.installedMigrationSetSha256,
          input.installedSchemaVersion,
          input.monitorLeaseExpiresAt,
          input.supervisorLeaseExpiresAt,
          input.emergencySupervisorLeaseExpiresAt,
          input.expiresAt,
          at,
          at,
        ],
      );
      affectedOne(run, "Gate 6 run admission");
      for (const action of input.actions) {
        const status = action.actionId === input.admitActionId ? "succeeded" : "registered";
        const [inserted] = await connection.execute(
          `
          INSERT INTO gate6_actions (
            gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
            kind, paired_action_id, predecessor_action_ids_json,
            required_stage, required_checker_sha256, status,
            before_evidence_sha256, after_evidence_sha256, expires_at,
            consumed_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            input.gate6Id,
            action.scope,
            action.actionId,
            action.approvalSha256,
            action.allowedMutationSha256,
            action.kind,
            action.pairedActionId,
            JSON.stringify(action.predecessorActionIds),
            action.requiredStage,
            action.requiredCheckerSha256,
            status,
            input.envelopeSha256,
            status === "succeeded" ? input.envelopeSha256 : null,
            action.expiresAt,
            status === "succeeded" ? at : null,
            status === "succeeded" ? at : null,
            at,
            at,
          ],
        );
        affectedOne(inserted, "Gate 6 action admission");
      }
      const [transferred] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET owner_type = 'gate6', owner_id = ?, state = 'active',
            transfer_token_sha256 = NULL, uncompensated_work = 0,
            heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production'
          AND owner_type = 'protected-install' AND owner_id = ? AND operation_id = ?
          AND transfer_token_sha256 = ? AND state = 'installed-awaiting-gate6'
          AND version = ?
      `,
        [
          input.gate6Id,
          at,
          input.expiresAt,
          at,
          input.installOperationId,
          input.installOperationId,
          input.transferTokenSha256,
          slot.version,
        ],
      );
      affectedOne(transferred, "Gate 6 installed slot transfer");
      return { status: "admitted", slotVersion: Number(slot.version) + 1 };
    });
  }

  async function beginAction(input) {
    const now = input.now ?? new Date();
    const checkedAt = now.toISOString();
    return transaction(pool, async (connection) => {
      const [slotRows] = await connection.execute(`
        SELECT owner_type, owner_id, state, version
        FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "production Gate 6 slot");
      if (
        slot.owner_type !== "gate6" ||
        slot.owner_id !== input.gate6Id ||
        slot.state !== "active"
      ) {
        throw new Error("production Gate 6 slot is not active for this run");
      }
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, envelope_sha256, envelope_core_sha256, status, current_stage,
               accepted_checker_sha256, monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at, expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.envelope_sha256 !== input.envelopeSha256 ||
        run.envelope_core_sha256 !== input.envelopeCoreSha256 ||
        run.status !== "active" ||
        run.current_stage !== input.expectedStage ||
        (run.accepted_checker_sha256 ?? null) !== (input.expectedCheckerSha256 ?? null) ||
        run.monitor_status !== "green" ||
        run.supervisor_status !== "green" ||
        time(run.monitor_lease_expires_at, "monitor lease") <= now.getTime() ||
        time(run.supervisor_lease_expires_at, "supervisor lease") <= now.getTime() ||
        time(run.expires_at, "envelope expiry") <= now.getTime()
      )
        throw new Error("Gate 6 run stage, identity, or liveness mismatch");
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
               kind, paired_action_id, status, required_stage,
               required_checker_sha256, predecessor_action_ids_json, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.scope, input.actionId],
      );
      const action = one(actionRows, "Gate 6 action");
      assertExactAction(action, input);
      if (
        action.kind === "compensation" ||
        action.status !== "registered" ||
        action.required_stage !== input.expectedStage ||
        (action.required_checker_sha256 ?? null) !== (input.expectedCheckerSha256 ?? null) ||
        time(action.expires_at, "action expiry") <= now.getTime()
      )
        throw new Error("Gate 6 action is not admissible");
      const predecessors =
        typeof action.predecessor_action_ids_json === "string"
          ? JSON.parse(action.predecessor_action_ids_json)
          : action.predecessor_action_ids_json;
      if (!Array.isArray(predecessors)) throw new Error("Gate 6 predecessor index is invalid");
      for (const predecessorId of predecessors) {
        const [predecessorRows] = await connection.execute(
          `
          SELECT action_id, status FROM gate6_actions
          WHERE gate6_id = ? AND action_id = ? FOR UPDATE
        `,
          [input.gate6Id, predecessorId],
        );
        const predecessor = one(predecessorRows, "Gate 6 predecessor");
        if (
          predecessor.action_id !== predecessorId ||
          !["succeeded", "compensated", "not_needed"].includes(predecessor.status)
        ) {
          throw new Error("Gate 6 predecessor evidence is incomplete");
        }
      }
      if (input.minimumCompensationValidityMs > 0) {
        const [recoveryRows] = await connection.execute(
          `
          SELECT expires_at FROM gate6_actions
          WHERE gate6_id = ? AND kind = 'compensation' AND paired_action_id = ?
          FOR UPDATE
        `,
          [input.gate6Id, input.actionId],
        );
        if (!Array.isArray(recoveryRows) || recoveryRows.length > 1) {
          throw new Error("Gate 6 compensation action is ambiguous");
        }
        const recovery = recoveryRows[0];
        if (
          recovery &&
          time(recovery.expires_at, "compensation expiry") <=
            now.getTime() + input.minimumCompensationValidityMs
        ) {
          throw new Error("Gate 6 compensation validity is insufficient");
        }
      }
      const [updated] = await connection.execute(
        `
        UPDATE gate6_actions SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'registered'
          AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `,
        [
          checkedAt,
          checkedAt,
          input.gate6Id,
          input.scope,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(updated, "Gate 6 action consumption");
      const [slotUpdated] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET uncompensated_work = 1, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND version = ?
      `,
        [checkedAt, checkedAt, input.gate6Id, slot.version],
      );
      affectedOne(slotUpdated, "Gate 6 slot fence");
      const receipt = Object.freeze({
        gate6Id: input.gate6Id,
        scope: input.scope,
        actionId: input.actionId,
        kind: action.kind,
        pairedActionId: action.paired_action_id ?? null,
        consumedAt: checkedAt,
      });
      receipts.add(receipt);
      return receipt;
    });
  }

  async function emergencyAbort(input) {
    for (const [value, label] of [
      [input.approvalSha256, "approval hash"],
      [input.allowedMutationSha256, "mutation hash"],
      [input.envelopeSha256, "envelope hash"],
      [input.envelopeCoreSha256, "envelope core hash"],
    ])
      hash(value, `Gate 6 emergency abort ${label}`);
    if (input.scope !== "gate6-abort" || !/^[a-z][a-z0-9-]{0,79}$/.test(input.reasonCode ?? ""))
      throw new Error("Gate 6 emergency abort identity is invalid");
    const now = input.now ?? new Date();
    const at = now.toISOString();
    const afterEvidenceSha256 = createHash("sha256")
      .update(
        JSON.stringify({
          actionId: input.actionId,
          gate6Id: input.gate6Id,
          reasonCode: input.reasonCode,
          status: "revoked",
        }),
      )
      .digest("hex");
    return transaction(pool, async (connection) => {
      const [slotRows] = await connection.execute(`
        SELECT owner_type, owner_id, state, version
        FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "production Gate 6 emergency slot");
      if (
        slot.owner_type !== "gate6" ||
        slot.owner_id !== input.gate6Id ||
        !["active", "sealed-verifying", "releasing"].includes(slot.state)
      )
        throw new Error("production Gate 6 slot is not emergency-abortable");
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, envelope_sha256, envelope_core_sha256, status, current_stage,
               monitor_status, supervisor_status
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 emergency run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.envelope_sha256 !== input.envelopeSha256 ||
        run.envelope_core_sha256 !== input.envelopeCoreSha256 ||
        !["active", "sealed-verifying", "releasing"].includes(run.status)
      )
        throw new Error("Gate 6 run is not emergency-abortable");
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
               kind, paired_action_id, status, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.scope, input.actionId],
      );
      const action = one(actionRows, "Gate 6 emergency action");
      assertExactAction(action, input);
      if (
        action.kind !== "emergency" ||
        action.paired_action_id !== null ||
        action.status !== "registered" ||
        time(action.expires_at, "Gate 6 emergency action expiry") <= now.getTime()
      )
        throw new Error("Gate 6 emergency action is not admissible");
      const [actionUpdated] = await connection.execute(
        `
        UPDATE gate6_actions
        SET status = 'succeeded', consumed_at = ?, after_evidence_sha256 = ?,
            completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'registered'
          AND approval_sha256 = ? AND allowed_mutation_sha256 = ? AND kind = 'emergency'
      `,
        [
          at,
          afterEvidenceSha256,
          at,
          at,
          input.gate6Id,
          input.scope,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(actionUpdated, "Gate 6 emergency action completion");
      const [runUpdated] = await connection.execute(
        `
        UPDATE gate6_runs
        SET status = 'revoked', revocation_reason_code = ?, updated_at = ?
        WHERE gate6_id = ? AND status IN ('active', 'sealed-verifying', 'releasing')
      `,
        [input.reasonCode, at, input.gate6Id],
      );
      affectedOne(runUpdated, "Gate 6 emergency run revocation");
      const [slotUpdated] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET state = 'revoked-uncompensated', uncompensated_work = 1,
            heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND version = ? AND state IN ('active', 'sealed-verifying', 'releasing')
      `,
        [at, at, input.gate6Id, slot.version],
      );
      affectedOne(slotUpdated, "Gate 6 emergency slot revocation");
      return Object.freeze({ status: "revoked", reasonCode: input.reasonCode });
    });
  }

  async function beginCompensation(input) {
    for (const [value, label] of [
      [input.approvalSha256, "approval hash"],
      [input.allowedMutationSha256, "mutation hash"],
      [input.envelopeSha256, "envelope hash"],
      [input.envelopeCoreSha256, "envelope core hash"],
    ])
      hash(value, `Gate 6 compensation ${label}`);
    const now = input.now ?? new Date();
    const at = now.toISOString();
    return transaction(pool, async (connection) => {
      const [slotRows] = await connection.execute(`
        SELECT owner_type, owner_id, state, version
        FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "production Gate 6 compensation slot");
      if (
        slot.owner_type !== "gate6" ||
        slot.owner_id !== input.gate6Id ||
        slot.state !== "revoked-uncompensated"
      )
        throw new Error("production Gate 6 slot is not awaiting compensation");
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, envelope_sha256, envelope_core_sha256, status,
               emergency_supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 compensation run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.envelope_sha256 !== input.envelopeSha256 ||
        run.envelope_core_sha256 !== input.envelopeCoreSha256 ||
        run.status !== "revoked" ||
        time(run.emergency_supervisor_lease_expires_at, "emergency supervisor lease") <=
          now.getTime()
      )
        throw new Error("Gate 6 compensation run or supervisor binding is invalid");
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
               kind, paired_action_id, status, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.scope, input.actionId],
      );
      const action = one(actionRows, "Gate 6 compensation action");
      assertExactAction(action, input);
      if (
        action.kind !== "compensation" ||
        action.paired_action_id !== input.pairedActionId ||
        action.status !== "registered" ||
        time(action.expires_at, "Gate 6 compensation expiry") <= now.getTime()
      )
        throw new Error("Gate 6 compensation action is not admissible");
      const [pairedRows] = await connection.execute(
        `
        SELECT status FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.pairedActionId],
      );
      const paired = one(pairedRows, "paired Gate 6 action");
      if (["registered", "not_needed"].includes(paired.status)) {
        throw new Error("paired Gate 6 action has no work to restore");
      }
      const [updated] = await connection.execute(
        `
        UPDATE gate6_actions SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'registered'
          AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `,
        [
          at,
          at,
          input.gate6Id,
          input.scope,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(updated, "Gate 6 compensation consumption");
      const [slotUpdated] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET uncompensated_work = 1, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND version = ?
      `,
        [at, at, input.gate6Id, slot.version],
      );
      affectedOne(slotUpdated, "Gate 6 compensation slot fence");
      const receipt = Object.freeze({
        gate6Id: input.gate6Id,
        scope: input.scope,
        actionId: input.actionId,
        kind: "compensation",
        pairedActionId: input.pairedActionId,
        consumedAt: at,
      });
      receipts.add(receipt);
      return receipt;
    });
  }

  async function finishAction(receipt, input) {
    if (!receipts.has(receipt)) throw new Error("durable Gate 6 receipt is required");
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [updated] = await connection.execute(
        `
        UPDATE gate6_actions
        SET status = ?, after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `,
        [
          input.status,
          input.afterEvidenceSha256,
          at,
          at,
          receipt.gate6Id,
          receipt.scope,
          receipt.actionId,
        ],
      );
      affectedOne(updated, "Gate 6 action completion");
      if (input.status !== "succeeded") {
        const [run] = await connection.execute(
          `
          UPDATE gate6_runs SET status = 'revoked', revocation_reason_code = 'controller-failure', updated_at = ?
          WHERE gate6_id = ? AND status = 'active'
        `,
          [at, receipt.gate6Id],
        );
        affectedOne(run, "Gate 6 controller revocation");
        const [slot] = await connection.execute(
          `
          UPDATE gate6_environment_slots
          SET state = 'revoked-uncompensated', uncompensated_work = 1, heartbeat_at = ?, updated_at = ?
          WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND state = 'active'
        `,
          [at, at, receipt.gate6Id],
        );
        affectedOne(slot, "Gate 6 controller revoked slot");
      } else if (receipt.kind === "compensation" && receipt.pairedActionId) {
        const [paired] = await connection.execute(
          `
          UPDATE gate6_actions SET status = 'compensated', updated_at = ?
          WHERE gate6_id = ? AND action_id = ? AND kind = 'forward'
            AND status IN ('consumed', 'succeeded', 'failed', 'ambiguous')
        `,
          [at, receipt.gate6Id, receipt.pairedActionId],
        );
        affectedOne(paired, "paired Gate 6 compensation");
        await clearUncompensatedIfSafe(connection, receipt.gate6Id, at);
      } else {
        await clearUncompensatedIfSafe(connection, receipt.gate6Id, at);
      }
    });
  }

  async function acceptSemanticChecker(receipt, input) {
    if (!receipts.has(receipt)) throw new Error("durable Gate 6 receipt is required");
    hash(input.acceptedCheckerSha256, "Gate 6 semantic checker hash");
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.checkerName ?? "") ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.nextStage ?? "")
    )
      throw new Error("Gate 6 semantic checker identity is invalid");
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [action] = await connection.execute(
        `
        UPDATE gate6_actions
        SET status = 'succeeded', after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `,
        [input.acceptedCheckerSha256, at, at, receipt.gate6Id, receipt.scope, receipt.actionId],
      );
      affectedOne(action, "Gate 6 semantic action completion");
      const [run] = await connection.execute(
        `
        UPDATE gate6_runs
        SET current_stage = ?, stage_version = stage_version + 1,
            accepted_checker_name = ?, accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'active'
      `,
        [input.nextStage, input.checkerName, input.acceptedCheckerSha256, at, receipt.gate6Id],
      );
      affectedOne(run, "Gate 6 semantic stage advancement");
      const [pinned] = await connection.execute(
        `
        UPDATE gate6_actions
        SET required_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND required_stage = ? AND status = 'registered'
          AND required_checker_sha256 IS NULL
      `,
        [input.acceptedCheckerSha256, at, receipt.gate6Id, input.nextStage],
      );
      if (!Number.isSafeInteger(pinned?.affectedRows)) {
        throw new Error("Gate 6 next-stage checker pinning failed");
      }
      await clearUncompensatedIfSafe(connection, receipt.gate6Id, at);
    });
  }

  async function reconcileStaleConsumedActions(input) {
    const now = input.now ?? new Date();
    const cutoffMs = time(input.staleBefore, "Gate 6 reconciliation cutoff");
    if (cutoffMs >= now.getTime()) throw new Error("Gate 6 reconciliation cutoff is invalid");
    const staleBefore = new Date(cutoffMs).toISOString();
    const at = now.toISOString();
    return transaction(pool, async (connection) => {
      const [selected] = await connection.execute(
        `
        SELECT action_id FROM gate6_actions
        WHERE gate6_id = ? AND status = 'consumed' AND consumed_at <= ?
        ORDER BY action_id FOR UPDATE
      `,
        [input.gate6Id, staleBefore],
      );
      if (!Array.isArray(selected))
        throw new Error("stale consumed Gate 6 actions returned an invalid result");
      if (selected.length === 0) return { status: "clean", ambiguousActionIds: [] };
      const actionIds = selected.map((row) => row.action_id);
      if (actionIds.some((actionId) => typeof actionId !== "string" || actionId.length === 0)) {
        throw new Error("stale Gate 6 action identity is invalid");
      }
      const placeholders = actionIds.map(() => "?").join(", ");
      const [actions] = await connection.execute(
        `
        UPDATE gate6_actions SET status = 'ambiguous', completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'consumed' AND action_id IN (${placeholders})
      `,
        [at, at, input.gate6Id, ...actionIds],
      );
      if (actions?.affectedRows !== actionIds.length) {
        throw new Error("Gate 6 stale action reconciliation compare-and-swap failed");
      }
      await revokeLocked(connection, input.gate6Id, "stale-consumed-action", at);
      return { status: "revoked", ambiguousActionIds: actionIds };
    });
  }

  async function revokeRun(input) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.reasonCode ?? "")) {
      throw new Error("Gate 6 revocation reason is invalid");
    }
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, (connection) =>
      revokeLocked(connection, input.gate6Id, input.reasonCode, at),
    );
  }

  async function renewLease(input) {
    if (
      !["monitor", "supervisor"].includes(input.lease) ||
      !["green", "red"].includes(input.status)
    ) {
      throw new Error("Gate 6 lease update is invalid");
    }
    const now = input.now ?? new Date();
    if (time(input.expiresAt, "Gate 6 lease expiry") <= now.getTime()) {
      throw new Error("Gate 6 lease expiry is stale");
    }
    const at = now.toISOString();
    await transaction(pool, async (connection) => {
      const statusColumn = input.lease === "monitor" ? "monitor_status" : "supervisor_status";
      const expiryColumn =
        input.lease === "monitor" ? "monitor_lease_expires_at" : "supervisor_lease_expires_at";
      const [run] = await connection.execute(
        `
        UPDATE gate6_runs
        SET ${statusColumn} = ?, ${expiryColumn} = ?, updated_at = ?
        WHERE gate6_id = ? AND status IN ('active', 'sealed-verifying', 'releasing')
      `,
        [input.status, input.expiresAt, at, input.gate6Id],
      );
      affectedOne(run, "Gate 6 lease renewal");
      if (input.status === "red") {
        await revokeLocked(connection, input.gate6Id, `${input.lease}-red`, at);
        return;
      }
      const [slot] = await connection.execute(
        `
        UPDATE gate6_environment_slots SET heartbeat_at = ?, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state IN ('active', 'sealed-verifying', 'releasing')
      `,
        [at, at, input.gate6Id],
      );
      affectedOne(slot, "Gate 6 slot heartbeat");
    });
  }

  async function sealForVerification(input) {
    hash(input.approvalSha256, "Gate 6 seal approval hash");
    hash(input.allowedMutationSha256, "Gate 6 seal mutation hash");
    hash(input.expectedCheckerSha256, "Gate 6 seal checker hash");
    hash(input.terminalEvidenceSha256, "Gate 6 terminal evidence hash");
    if (input.scope !== "gate6-seal-close" || input.expectedStage !== "pre-close-accepted") {
      throw new Error("Gate 6 seal scope or stage is invalid");
    }
    const now = input.now ?? new Date();
    const at = now.toISOString();
    await transaction(pool, async (connection) => {
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 seal run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.status !== "active" ||
        run.current_stage !== input.expectedStage ||
        run.accepted_checker_sha256 !== input.expectedCheckerSha256 ||
        run.monitor_status !== "green" ||
        run.supervisor_status !== "green" ||
        time(run.monitor_lease_expires_at, "monitor lease") <= now.getTime() ||
        time(run.supervisor_lease_expires_at, "supervisor lease") <= now.getTime()
      )
        throw new Error("Gate 6 seal run, stage, or liveness binding is invalid");
      const [slotRows] = await connection.execute(`
        SELECT owner_id, state, uncompensated_work
        FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "Gate 6 seal slot");
      if (
        slot.owner_id !== input.gate6Id ||
        slot.state !== "active" ||
        Number(slot.uncompensated_work) !== 0
      ) {
        throw new Error("Gate 6 seal slot is not safe");
      }
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256, status
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-seal-close' AND action_id = ?
        FOR UPDATE
      `,
        [input.gate6Id, input.actionId],
      );
      const action = one(actionRows, "Gate 6 seal action");
      if (
        action.gate6_id !== input.gate6Id ||
        action.scope !== input.scope ||
        action.action_id !== input.actionId ||
        action.approval_sha256 !== input.approvalSha256 ||
        action.allowed_mutation_sha256 !== input.allowedMutationSha256 ||
        action.status !== "registered"
      )
        throw new Error("Gate 6 seal action binding is invalid");
      const [blockingRows] = await connection.execute(
        `
        SELECT
          SUM(status = 'ambiguous') AS ambiguous_count,
          SUM(kind = 'forward' AND scope NOT IN ('gate6-seal-close', 'gate6-release')
              AND status NOT IN ('succeeded', 'compensated', 'not_needed')) AS incomplete_forward_count,
          SUM(scope = 'db-principal-revoke-legacy' AND status = 'succeeded') AS revoke_succeeded_count,
          SUM(scope = 'db-principal-restore-legacy' AND kind = 'compensation'
              AND status = 'registered') AS restore_registered_count,
          SUM(scope = 'db-principal-restore-legacy' AND kind = 'compensation'
              AND status = 'succeeded') AS restore_succeeded_count
        FROM gate6_actions WHERE gate6_id = ?
      `,
        [input.gate6Id],
      );
      const blocking = one(blockingRows, "Gate 6 seal actions");
      const [permitRows] = await connection.execute(
        `
        SELECT COUNT(*) AS count FROM gate6_fault_permits
        WHERE gate6_id = ? AND status = 'armed'
      `,
        [input.gate6Id],
      );
      const permits = one(permitRows, "Gate 6 seal permits");
      const postProofSafe =
        (Number(blocking.revoke_succeeded_count) === 1 &&
          Number(blocking.restore_registered_count) === 1) ||
        Number(blocking.restore_succeeded_count) === 1;
      if (
        Number(blocking.ambiguous_count) !== 0 ||
        Number(blocking.incomplete_forward_count) !== 0 ||
        Number(permits.count) !== 0 ||
        !postProofSafe
      )
        throw new Error("Gate 6 seal has incomplete actions or active permits");
      const [actionUpdate] = await connection.execute(
        `
        UPDATE gate6_actions
        SET status = 'succeeded', consumed_at = ?, completed_at = ?,
            before_evidence_sha256 = ?, after_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-seal-close' AND action_id = ?
          AND status = 'registered' AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `,
        [
          at,
          at,
          input.expectedCheckerSha256,
          input.terminalEvidenceSha256,
          at,
          input.gate6Id,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(actionUpdate, "Gate 6 seal action consumption");
      const [runUpdate] = await connection.execute(
        `
        UPDATE gate6_runs SET status = 'sealed-verifying', current_stage = 'sealed-verifying',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-seal-close',
            accepted_checker_sha256 = ?, terminal_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'active'
      `,
        [input.terminalEvidenceSha256, input.terminalEvidenceSha256, at, input.gate6Id],
      );
      affectedOne(runUpdate, "Gate 6 run seal");
      const [slotUpdate] = await connection.execute(
        `
        UPDATE gate6_environment_slots SET state = 'sealed-verifying',
            uncompensated_work = 0, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND state = 'active'
      `,
        [at, at, input.gate6Id],
      );
      affectedOne(slotUpdate, "Gate 6 slot seal");
    });
  }

  async function releaseRun(input) {
    hash(input.verifierSha256, "Gate 6 release verifier hash");
    hash(input.terminalEvidenceSha256, "Gate 6 terminal evidence hash");
    hash(input.approvalSha256, "Gate 6 release approval hash");
    hash(input.allowedMutationSha256, "Gate 6 release mutation hash");
    if (input.scope !== "gate6-release") throw new Error("Gate 6 release scope is invalid");
    const now = input.now ?? new Date();
    const at = now.toISOString();
    return transaction(pool, async (connection) => {
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status, terminal_evidence_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "sealed Gate 6 release run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.status !== "sealed-verifying" ||
        run.terminal_evidence_sha256 !== input.terminalEvidenceSha256 ||
        run.monitor_status !== "green" ||
        run.supervisor_status !== "green" ||
        time(run.monitor_lease_expires_at, "monitor lease") <= now.getTime() ||
        time(run.supervisor_lease_expires_at, "supervisor lease") <= now.getTime()
      )
        throw new Error("Gate 6 release run or liveness binding is invalid");
      const [slotRows] = await connection.execute(`
        SELECT owner_id, state FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "sealed Gate 6 release slot");
      if (slot.owner_id !== input.gate6Id || slot.state !== "sealed-verifying") {
        throw new Error("Gate 6 release slot binding is invalid");
      }
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256, status
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ?
        FOR UPDATE
      `,
        [input.gate6Id, input.actionId],
      );
      const action = one(actionRows, "Gate 6 release action");
      if (
        action.gate6_id !== input.gate6Id ||
        action.scope !== input.scope ||
        action.action_id !== input.actionId ||
        action.approval_sha256 !== input.approvalSha256 ||
        action.allowed_mutation_sha256 !== input.allowedMutationSha256 ||
        action.status !== "registered"
      )
        throw new Error("Gate 6 release action binding is invalid");
      const [restoreRows] = await connection.execute(
        `
        SELECT gate6_id, action_id, kind, status
        FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.restoreActionId],
      );
      const restore = one(restoreRows, "Gate 6 release restore action");
      if (
        restore.gate6_id !== input.gate6Id ||
        restore.action_id !== input.restoreActionId ||
        restore.kind !== "compensation" ||
        !["registered", "succeeded"].includes(restore.status)
      )
        throw new Error("Gate 6 release restore capability is unavailable");
      const [actionUpdate] = await connection.execute(
        `
        UPDATE gate6_actions
        SET status = 'consumed', consumed_at = ?, before_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ?
          AND status = 'registered' AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `,
        [
          at,
          input.terminalEvidenceSha256,
          at,
          input.gate6Id,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(actionUpdate, "Gate 6 release action consumption");
      const [runUpdate] = await connection.execute(
        `
        UPDATE gate6_runs
        SET status = 'releasing', current_stage = 'releasing',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-final-verifier',
            accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'sealed-verifying'
          AND terminal_evidence_sha256 = ?
      `,
        [input.verifierSha256, at, input.gate6Id, input.terminalEvidenceSha256],
      );
      affectedOne(runUpdate, "Gate 6 release");
      const [slotUpdate] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET state = 'releasing', uncompensated_work = 1,
            heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'sealed-verifying'
      `,
        [at, at, input.gate6Id],
      );
      affectedOne(slotUpdate, "Gate 6 releasing slot");
      return { status: "releasing" };
    });
  }

  async function completeRelease(input) {
    hash(input.terminalEvidenceSha256, "Gate 6 release terminal evidence hash");
    hash(input.cleanupEvidenceSha256, "Gate 6 release cleanup evidence hash");
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status, terminal_evidence_sha256
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "releasing Gate 6 run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.status !== "releasing" ||
        run.terminal_evidence_sha256 !== input.terminalEvidenceSha256
      )
        throw new Error("Gate 6 run is not awaiting cleanup completion");
      const [slotRows] = await connection.execute(`
        SELECT owner_id, state FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "releasing Gate 6 slot");
      if (slot.owner_id !== input.gate6Id || slot.state !== "releasing") {
        throw new Error("Gate 6 slot is not awaiting cleanup completion");
      }
      const [releaseRows] = await connection.execute(
        `
        SELECT gate6_id, action_id, status FROM gate6_actions
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.actionId],
      );
      const release = one(releaseRows, "consumed Gate 6 release action");
      if (
        release.gate6_id !== input.gate6Id ||
        release.action_id !== input.actionId ||
        release.status !== "consumed"
      ) {
        throw new Error("Gate 6 release action is not consumed");
      }
      const [restoreRows] = await connection.execute(
        `
        SELECT gate6_id, action_id, kind, status FROM gate6_actions
        WHERE gate6_id = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.restoreActionId],
      );
      const restore = one(restoreRows, "Gate 6 restore action");
      if (
        restore.gate6_id !== input.gate6Id ||
        restore.action_id !== input.restoreActionId ||
        restore.kind !== "compensation" ||
        !["registered", "succeeded"].includes(restore.status)
      )
        throw new Error("Gate 6 restore action is unavailable at cleanup completion");
      if (restore.status === "registered") {
        const [restoreUpdate] = await connection.execute(
          `
          UPDATE gate6_actions SET status = 'not_needed', completed_at = ?, updated_at = ?
          WHERE gate6_id = ? AND action_id = ? AND kind = 'compensation' AND status = 'registered'
        `,
          [at, at, input.gate6Id, input.restoreActionId],
        );
        affectedOne(restoreUpdate, "Gate 6 unused restore terminalization");
      }
      const [releaseUpdate] = await connection.execute(
        `
        UPDATE gate6_actions SET status = 'succeeded', after_evidence_sha256 = ?,
            completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = 'gate6-release' AND action_id = ? AND status = 'consumed'
      `,
        [input.cleanupEvidenceSha256, at, at, input.gate6Id, input.actionId],
      );
      affectedOne(releaseUpdate, "Gate 6 release completion");
      const [runUpdate] = await connection.execute(
        `
        UPDATE gate6_runs SET status = 'released', current_stage = 'released',
            stage_version = stage_version + 1, accepted_checker_name = 'gate6-release-cleanup',
            accepted_checker_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'releasing' AND terminal_evidence_sha256 = ?
      `,
        [input.cleanupEvidenceSha256, at, input.gate6Id, input.terminalEvidenceSha256],
      );
      affectedOne(runUpdate, "Gate 6 released run");
      const [slotUpdate] = await connection.execute(
        `
        UPDATE gate6_environment_slots SET state = 'released', uncompensated_work = 0,
            heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'releasing'
      `,
        [at, at, at, input.gate6Id],
      );
      affectedOne(slotUpdate, "Gate 6 released slot");
    });
  }

  async function completeRollback(input) {
    hash(input.rollbackEvidenceSha256, "Gate 6 rollback evidence hash");
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status FROM gate6_runs
        WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "revoked Gate 6 rollback run");
      if (run.gate6_id !== input.gate6Id || run.status !== "revoked") {
        throw new Error("Gate 6 run is not awaiting rollback completion");
      }
      const [slotRows] = await connection.execute(`
        SELECT owner_id, state FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "revoked Gate 6 rollback slot");
      if (slot.owner_id !== input.gate6Id || slot.state !== "revoked-uncompensated") {
        throw new Error("Gate 6 slot is not awaiting rollback completion");
      }
      const [unsafeRows] = await connection.execute(
        `
        SELECT SUM(status IN ('consumed', 'failed', 'ambiguous')) AS unsafe_count
        FROM gate6_actions WHERE gate6_id = ?
      `,
        [input.gate6Id],
      );
      const unsafe = one(unsafeRows, "Gate 6 rollback action safety");
      const [permitRows] = await connection.execute(
        `
        SELECT COUNT(*) AS count FROM gate6_fault_permits
        WHERE gate6_id = ? AND status = 'armed'
      `,
        [input.gate6Id],
      );
      const permits = one(permitRows, "Gate 6 rollback permit safety");
      if (Number(unsafe.unsafe_count) !== 0 || Number(permits.count) !== 0) {
        throw new Error("Gate 6 rollback still has unsafe work or permits");
      }
      const [runUpdate] = await connection.execute(
        `
        UPDATE gate6_runs SET status = 'rolled-back', current_stage = 'rolled-back',
            stage_version = stage_version + 1,
            accepted_checker_name = 'gate6-rollback-supervisor',
            accepted_checker_sha256 = ?, terminal_evidence_sha256 = ?, updated_at = ?
        WHERE gate6_id = ? AND status = 'revoked'
      `,
        [input.rollbackEvidenceSha256, input.rollbackEvidenceSha256, at, input.gate6Id],
      );
      affectedOne(runUpdate, "Gate 6 rollback completion");
      const [slotUpdate] = await connection.execute(
        `
        UPDATE gate6_environment_slots SET state = 'released', uncompensated_work = 0,
            heartbeat_at = ?, expires_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'revoked-uncompensated'
      `,
        [at, at, at, input.gate6Id],
      );
      affectedOne(slotUpdate, "Gate 6 rollback slot release");
    });
  }

  async function registerTask9Permit(input) {
    const now = input.now ?? new Date();
    const at = now.toISOString();
    if (
      ![
        input.approvalSha256,
        input.allowedMutationSha256,
        input.drillSha256,
        input.signedPermitSha256,
        input.expectedCheckerSha256,
      ].every((value) => /^[0-9a-f]{64}$/.test(value ?? "")) ||
      (input.targetSha256 !== null && !/^[0-9a-f]{64}$/.test(input.targetSha256)) ||
      (input.fixtureSha256 !== null && !/^[0-9a-f]{64}$/.test(input.fixtureSha256)) ||
      !["line-service", "ocr-service"].includes(input.service) ||
      !Number.isSafeInteger(input.teamId) ||
      input.teamId <= 0 ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= now.getTime() ||
      Date.parse(input.expiresAt) - now.getTime() > 120_000
    )
      throw new Error("Gate 6 Task 9 permit input is invalid");
    return transaction(pool, async (connection) => {
      const [slotRows] = await connection.execute(`
        SELECT owner_id, state, version FROM gate6_environment_slots
        WHERE environment = 'production' FOR UPDATE
      `);
      const slot = one(slotRows, "Gate 6 Task 9 slot");
      if (slot.owner_id !== input.gate6Id || slot.state !== "active") {
        throw new Error("Gate 6 Task 9 slot is inactive");
      }
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at, expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 Task 9 run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.status !== "active" ||
        run.current_stage !== "db-transition-stable" ||
        run.accepted_checker_sha256 !== input.expectedCheckerSha256 ||
        run.monitor_status !== "green" ||
        run.supervisor_status !== "green" ||
        time(run.monitor_lease_expires_at, "monitor lease") <= now.getTime() ||
        time(run.supervisor_lease_expires_at, "supervisor lease") <= now.getTime() ||
        time(run.expires_at, "envelope expiry") <= now.getTime()
      )
        throw new Error("Gate 6 Task 9 run or liveness binding is invalid");
      const [actionRows] = await connection.execute(
        `
        SELECT gate6_id, scope, action_id, status, approval_sha256,
               allowed_mutation_sha256, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope = ? AND action_id = ? FOR UPDATE
      `,
        [input.gate6Id, input.scope, input.actionId],
      );
      const action = one(actionRows, "Gate 6 Task 9 action");
      if (
        action.gate6_id !== input.gate6Id ||
        action.scope !== input.scope ||
        action.action_id !== input.actionId ||
        action.status !== "registered" ||
        action.approval_sha256 !== input.approvalSha256 ||
        action.allowed_mutation_sha256 !== input.allowedMutationSha256 ||
        time(action.expires_at, "Task 9 action expiry") <= now.getTime()
      )
        throw new Error("Gate 6 Task 9 action binding is invalid");
      const [permit] = await connection.execute(
        `
        INSERT INTO gate6_fault_permits (
          permit_id, gate6_id, scope, action_id, service, kind, team_id,
          drill_sha256, target_sha256, fixture_sha256, signed_permit_sha256,
          verification_key_id, status, expires_at, consumed_at, disarmed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, NULL, NULL, ?, ?)
      `,
        [
          input.permitId,
          input.gate6Id,
          input.scope,
          input.actionId,
          input.service,
          input.kind,
          input.teamId,
          input.drillSha256,
          input.targetSha256,
          input.fixtureSha256,
          input.signedPermitSha256,
          input.keyId,
          input.expiresAt,
          at,
          at,
        ],
      );
      affectedOne(permit, "Gate 6 Task 9 permit registration");
      const [actionUpdate] = await connection.execute(
        `
        UPDATE gate6_actions SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'registered'
          AND approval_sha256 = ? AND allowed_mutation_sha256 = ?
      `,
        [
          at,
          at,
          input.gate6Id,
          input.scope,
          input.actionId,
          input.approvalSha256,
          input.allowedMutationSha256,
        ],
      );
      affectedOne(actionUpdate, "Gate 6 Task 9 action consumption");
      const [slotUpdate] = await connection.execute(
        `
        UPDATE gate6_environment_slots
        SET uncompensated_work = 1, heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ?
          AND state = 'active' AND version = ?
      `,
        [at, at, input.gate6Id, slot.version],
      );
      affectedOne(slotUpdate, "Gate 6 Task 9 slot fence");
      const receipt = Object.freeze({
        status: "armed",
        gate6Id: input.gate6Id,
        scope: input.scope,
        actionId: input.actionId,
        permitId: input.permitId,
      });
      task9Receipts.add(receipt);
      return receipt;
    });
  }

  async function disarmTask9Permit(receipt, input = {}) {
    if (!task9Receipts.has(receipt)) throw new Error("durable Gate 6 Task 9 receipt is required");
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [updated] = await connection.execute(
        `
        UPDATE gate6_fault_permits
        SET status = IF(status = 'armed', 'disarmed', status), disarmed_at = ?, updated_at = ?
        WHERE permit_id = ? AND gate6_id = ? AND status IN ('armed', 'consumed', 'expired', 'disarmed')
      `,
        [at, at, receipt.permitId, receipt.gate6Id],
      );
      affectedOne(updated, "Gate 6 Task 9 permit disarm");
    });
  }

  async function disarmAllTask9Permits(input) {
    const at = (input.now ?? new Date()).toISOString();
    return transaction(pool, async (connection) => {
      const [updated] = await connection.execute(
        `
        UPDATE gate6_fault_permits
        SET status = 'disarmed', disarmed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND status IN ('armed', 'consumed', 'expired')
      `,
        [at, at, input.gate6Id],
      );
      if (!Number.isSafeInteger(updated?.affectedRows) || updated.affectedRows < 0) {
        throw new Error("Gate 6 fault permit reconciliation failed");
      }
      const [remainingRows] = await connection.execute(
        `
        SELECT COUNT(*) AS count FROM gate6_fault_permits
        WHERE gate6_id = ? AND status = 'armed'
      `,
        [input.gate6Id],
      );
      const remaining = one(remainingRows, "Gate 6 armed permit reconciliation");
      if (Number(remaining.count) !== 0) throw new Error("Gate 6 fault permits remain armed");
      return { status: "disarmed", changedCount: updated.affectedRows };
    });
  }

  async function getTask9PermitStatus(receipt) {
    if (!task9Receipts.has(receipt)) throw new Error("durable Gate 6 Task 9 receipt is required");
    return transaction(pool, async (connection) => {
      const [rows] = await connection.execute(
        `
        SELECT status FROM gate6_fault_permits
        WHERE permit_id = ? AND gate6_id = ? AND scope = ? AND action_id = ?
        FOR UPDATE
      `,
        [receipt.permitId, receipt.gate6Id, receipt.scope, receipt.actionId],
      );
      const permit = one(rows, "Gate 6 Task 9 permit status");
      if (!["armed", "consumed", "disarmed", "expired"].includes(permit.status)) {
        throw new Error("Gate 6 Task 9 permit status is invalid");
      }
      return permit.status;
    });
  }

  async function completeTask9PermitAction(receipt, input) {
    if (!task9Receipts.has(receipt)) throw new Error("durable Gate 6 Task 9 receipt is required");
    if (
      !["succeeded", "ambiguous"].includes(input.status) ||
      !/^[0-9a-f]{64}$/.test(input.afterEvidenceSha256 ?? "")
    ) {
      throw new Error("Gate 6 Task 9 completion is invalid");
    }
    const at = (input.now ?? new Date()).toISOString();
    await transaction(pool, async (connection) => {
      const [selectedRows] = await connection.execute(
        `
        SELECT a.gate6_id, a.scope, a.action_id, a.status AS action_status,
               p.permit_id, p.status AS permit_status, p.disarmed_at
        FROM gate6_actions a
        JOIN gate6_fault_permits p
          ON p.gate6_id = a.gate6_id AND p.scope = a.scope AND p.action_id = a.action_id
        WHERE a.gate6_id = ? AND a.scope = ? AND a.action_id = ? AND p.permit_id = ?
        FOR UPDATE
      `,
        [receipt.gate6Id, receipt.scope, receipt.actionId, receipt.permitId],
      );
      const row = one(selectedRows, "consumed Gate 6 Task 9 action");
      if (
        row.action_status !== "consumed" ||
        !["consumed", "disarmed"].includes(row.permit_status) ||
        row.disarmed_at === null
      )
        throw new Error("Gate 6 Task 9 action or permit is not terminal");
      const [updated] = await connection.execute(
        `
        UPDATE gate6_actions SET status = ?, after_evidence_sha256 = ?, completed_at = ?, updated_at = ?
        WHERE gate6_id = ? AND scope = ? AND action_id = ? AND status = 'consumed'
      `,
        [
          input.status,
          input.afterEvidenceSha256,
          at,
          at,
          receipt.gate6Id,
          receipt.scope,
          receipt.actionId,
        ],
      );
      affectedOne(updated, "Gate 6 Task 9 action completion");
      if (input.status === "succeeded") {
        await clearUncompensatedIfSafe(connection, receipt.gate6Id, at);
      } else {
        const [run] = await connection.execute(
          `
          UPDATE gate6_runs SET status = 'revoked', revocation_reason_code = 'task9-controller-failure', updated_at = ?
          WHERE gate6_id = ? AND status = 'active'
        `,
          [at, receipt.gate6Id],
        );
        affectedOne(run, "Gate 6 Task 9 revocation");
        const [slot] = await connection.execute(
          `
          UPDATE gate6_environment_slots SET state = 'revoked-uncompensated',
              uncompensated_work = 1, heartbeat_at = ?, updated_at = ?
          WHERE environment = 'production' AND owner_type = 'gate6' AND owner_id = ? AND state = 'active'
        `,
          [at, at, receipt.gate6Id],
        );
        affectedOne(slot, "Gate 6 Task 9 revoked slot");
      }
    });
  }

  async function getSanitizedSnapshot(gate6Id) {
    const [rows] = await pool.execute(
      "SELECT * FROM operational_gate6_terminal_evidence WHERE gate6_id = ?",
      [gate6Id],
    );
    if (!Array.isArray(rows) || rows.length > 1) throw new Error("Gate 6 snapshot is ambiguous");
    return rows[0] ?? null;
  }

  async function getPostProofRestoreAction(gate6Id) {
    const [rows] = await pool.execute(
      `
      SELECT gate6_id, action_id, status
      FROM gate6_actions
      WHERE gate6_id = ? AND scope = 'db-principal-restore-legacy'
        AND kind = 'compensation' AND status IN ('registered', 'succeeded')
    `,
      [gate6Id],
    );
    const row = one(rows, "Gate 6 post-proof restore action");
    if (row.gate6_id !== gate6Id) throw new Error("Gate 6 post-proof restore identity mismatch");
    return { actionId: row.action_id, status: row.status };
  }

  async function registerPostProofActions(input) {
    hash(input.expectedCheckerSha256, "Gate 6 pre-close checker hash");
    const at = new Date(input.now ?? new Date()).toISOString();
    const expected = [
      {
        action: input.revoke,
        scope: "db-principal-revoke-legacy",
        kind: "forward",
        pairedActionId: null,
        requiredStage: "pre-close-accepted",
      },
      {
        action: input.restore,
        scope: "db-principal-restore-legacy",
        kind: "compensation",
        pairedActionId: input.revoke?.actionId,
        requiredStage: "revoked",
      },
    ];
    for (const descriptor of expected) {
      const action = descriptor.action;
      if (
        action?.scope !== descriptor.scope ||
        action?.kind !== descriptor.kind ||
        action?.pairedActionId !== descriptor.pairedActionId ||
        action?.requiredStage !== descriptor.requiredStage ||
        action?.requiredCheckerSha256 !== input.expectedCheckerSha256 ||
        !Array.isArray(action?.predecessorActionIds) ||
        action.predecessorActionIds.length !== 0 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action?.actionId ?? "") ||
        !SHA256.test(action?.approvalSha256 ?? "") ||
        !SHA256.test(action?.allowedMutationSha256 ?? "") ||
        time(action?.expiresAt, "Gate 6 post-proof action expiry") <=
          time(at, "Gate 6 post-proof registration time")
      )
        throw new Error("Gate 6 post-proof action pair is invalid");
    }
    if (
      input.revoke.actionId === input.restore.actionId ||
      time(input.restore.expiresAt, "Gate 6 restore expiry") <=
        time(input.revoke.expiresAt, "Gate 6 revoke expiry")
    )
      throw new Error("Gate 6 post-proof recovery window is invalid");
    return transaction(pool, async (connection) => {
      const [runRows] = await connection.execute(
        `
        SELECT gate6_id, status, current_stage, accepted_checker_sha256,
               monitor_status, monitor_lease_expires_at,
               supervisor_status, supervisor_lease_expires_at
        FROM gate6_runs WHERE gate6_id = ? FOR UPDATE
      `,
        [input.gate6Id],
      );
      const run = one(runRows, "Gate 6 post-proof run");
      if (
        run.gate6_id !== input.gate6Id ||
        run.status !== "active" ||
        run.current_stage !== input.expectedStage ||
        run.accepted_checker_sha256 !== input.expectedCheckerSha256 ||
        run.monitor_status !== "green" ||
        run.supervisor_status !== "green" ||
        time(run.monitor_lease_expires_at, "Gate 6 monitor lease") <=
          time(at, "Gate 6 registration time") ||
        time(run.supervisor_lease_expires_at, "Gate 6 supervisor lease") <=
          time(at, "Gate 6 registration time")
      )
        throw new Error("Gate 6 post-proof run binding is invalid");
      const [existingRows] = await connection.execute(
        `
        SELECT scope, action_id, approval_sha256, allowed_mutation_sha256,
               kind, paired_action_id, predecessor_action_ids_json,
               required_stage, required_checker_sha256, status, expires_at
        FROM gate6_actions
        WHERE gate6_id = ? AND scope IN (
          'db-principal-revoke-legacy', 'db-principal-restore-legacy'
        ) FOR UPDATE
      `,
        [input.gate6Id],
      );
      if (!Array.isArray(existingRows))
        throw new Error("Gate 6 post-proof actions are unavailable");
      if (existingRows.length !== 0) {
        if (existingRows.length !== 2)
          throw new Error("Gate 6 post-proof action pair is incomplete");
        for (const descriptor of expected) {
          const action = descriptor.action;
          const row = existingRows.find((candidate) => candidate.scope === action.scope);
          if (
            !row ||
            row.action_id !== action.actionId ||
            row.approval_sha256 !== action.approvalSha256 ||
            row.allowed_mutation_sha256 !== action.allowedMutationSha256 ||
            row.kind !== action.kind ||
            row.paired_action_id !== action.pairedActionId ||
            row.predecessor_action_ids_json !== "[]" ||
            row.required_stage !== action.requiredStage ||
            row.required_checker_sha256 !== action.requiredCheckerSha256 ||
            !["registered", "consumed", "succeeded", "compensated", "not_needed"].includes(
              row.status,
            ) ||
            new Date(row.expires_at).toISOString() !== new Date(action.expiresAt).toISOString()
          )
            throw new Error("Gate 6 post-proof action replay conflicts with durable state");
        }
        return { status: "registered", replayed: true };
      }
      for (const descriptor of expected) {
        const action = descriptor.action;
        const [inserted] = await connection.execute(
          `
          INSERT INTO gate6_actions (
            gate6_id, scope, action_id, approval_sha256, allowed_mutation_sha256,
            kind, paired_action_id, predecessor_action_ids_json,
            required_stage, required_checker_sha256, status, expires_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'registered', ?, ?, ?)
        `,
          [
            input.gate6Id,
            action.scope,
            action.actionId,
            action.approvalSha256,
            action.allowedMutationSha256,
            action.kind,
            action.pairedActionId,
            action.requiredStage,
            action.requiredCheckerSha256,
            action.expiresAt,
            at,
            at,
          ],
        );
        affectedOne(inserted, "Gate 6 post-proof action registration");
      }
      return { status: "registered" };
    });
  }

  async function getSupervisorState(gate6Id) {
    const [rows] = await pool.execute(
      `
      SELECT gate6_id, status, current_stage,
             monitor_status, monitor_lease_expires_at,
             supervisor_status, supervisor_lease_expires_at,
             emergency_supervisor_lease_expires_at, expires_at
      FROM gate6_runs WHERE gate6_id = ?
    `,
      [gate6Id],
    );
    const row = one(rows, "Gate 6 supervisor state");
    if (row.gate6_id !== gate6Id) throw new Error("Gate 6 supervisor identity mismatch");
    return Object.freeze({
      gate6Id: row.gate6_id,
      status: row.status,
      currentStage: row.current_stage,
      monitorStatus: row.monitor_status,
      monitorLeaseExpiresAt: new Date(row.monitor_lease_expires_at).toISOString(),
      supervisorStatus: row.supervisor_status,
      supervisorLeaseExpiresAt: new Date(row.supervisor_lease_expires_at).toISOString(),
      emergencySupervisorLeaseExpiresAt: new Date(
        row.emergency_supervisor_lease_expires_at,
      ).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  async function getWorkerHandoffState(gate6Id) {
    const [rows] = await pool.execute(
      `
      SELECT scope, status
      FROM gate6_actions
      WHERE gate6_id = ? AND scope IN (
        'worker-ifn-forward', 'worker-ifn-reverse', 'worker-ifn-restore-prior',
        'worker-ptwl-forward', 'worker-ptwl-reverse', 'worker-ptwl-restore-prior'
      )
    `,
      [gate6Id],
    );
    if (!Array.isArray(rows)) throw new Error("Gate 6 worker handoff state is unavailable");
    const activeTeams = [];
    for (const [partition, teamId] of [
      ["ifn", 2],
      ["ptwl", 1],
    ]) {
      const consumed = rows.filter(
        (row) => row.status === "consumed" && row.scope.startsWith(`worker-${partition}-`),
      );
      if (consumed.length > 1) throw new Error("Gate 6 worker handoff state is ambiguous");
      if (consumed.length === 1) activeTeams.push(teamId);
    }
    return Object.freeze({
      allowedMissingTeamIds: activeTeams.sort((left, right) => left - right),
    });
  }

  async function getProductionSlotForHandoff() {
    const [rows] = await pool.execute(`
      SELECT environment, owner_type, owner_id, operation_id, transfer_token_sha256,
             state, version, protected_install_evidence_sha256, release_sha,
             target_descriptor_sha256, operator_bundle_sha256,
             installed_migration_set_sha256, installed_schema_version,
             uncompensated_work, heartbeat_at, expires_at
      FROM gate6_environment_slots
      WHERE environment = 'production'
    `);
    return one(rows, "production Gate 6 handoff slot");
  }

  async function getActionBinding(gate6Id, scope, actionId) {
    const [rows] = await pool.execute(
      `
      SELECT gate6_id, scope, action_id, required_stage, required_checker_sha256
      FROM gate6_actions
      WHERE gate6_id = ? AND scope = ? AND action_id = ?
    `,
      [gate6Id, scope, actionId],
    );
    const row = one(rows, "Gate 6 action binding");
    if (row.gate6_id !== gate6Id || row.scope !== scope || row.action_id !== actionId) {
      throw new Error("Gate 6 action binding identity mismatch");
    }
    return {
      expectedStage: row.required_stage,
      expectedCheckerSha256: row.required_checker_sha256 ?? null,
    };
  }

  async function getAcceptedSemanticBinding(gate6Id, scope, actionId) {
    for (const [value, label] of [
      [gate6Id, "Gate 6 ID"],
      [scope, "Gate 6 semantic scope"],
      [actionId, "Gate 6 semantic action ID"],
    ]) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new Error(`${label} is invalid`);
      }
    }
    const [rows] = await pool.execute(
      `
      SELECT a.status AS action_status,
             a.after_evidence_sha256,
             r.status AS run_status,
             r.current_stage,
             r.accepted_checker_name,
             r.accepted_checker_sha256,
             s.owner_type AS slot_owner_type,
             s.owner_id AS slot_owner_id,
             s.state AS slot_state,
             s.version AS slot_version,
             r.monitor_status,
             r.monitor_lease_expires_at,
             r.supervisor_status,
             r.supervisor_lease_expires_at
      FROM gate6_actions a
      JOIN gate6_runs r ON r.gate6_id = a.gate6_id
      JOIN gate6_environment_slots s ON s.environment = 'production'
      WHERE a.gate6_id = ? AND a.scope = ? AND a.action_id = ?
    `,
      [gate6Id, scope, actionId],
    );
    const row = one(rows, "accepted Gate 6 semantic binding");
    for (const [value, label] of [
      [row.after_evidence_sha256, "accepted Gate 6 action evidence hash"],
      [row.accepted_checker_sha256, "accepted Gate 6 checker hash"],
    ])
      hash(value, label);
    if (
      typeof row.action_status !== "string" ||
      typeof row.run_status !== "string" ||
      typeof row.current_stage !== "string" ||
      typeof row.accepted_checker_name !== "string" ||
      typeof row.slot_owner_type !== "string" ||
      typeof row.slot_owner_id !== "string" ||
      typeof row.slot_state !== "string" ||
      !Number.isSafeInteger(Number(row.slot_version)) ||
      Number(row.slot_version) < 1 ||
      typeof row.monitor_status !== "string" ||
      typeof row.supervisor_status !== "string"
    )
      throw new Error("accepted Gate 6 semantic binding is invalid");
    const monitorLeaseExpiresAt = new Date(
      time(row.monitor_lease_expires_at, "Gate 6 monitor lease expiry"),
    ).toISOString();
    const supervisorLeaseExpiresAt = new Date(
      time(row.supervisor_lease_expires_at, "Gate 6 supervisor lease expiry"),
    ).toISOString();
    return Object.freeze({
      actionStatus: row.action_status,
      afterEvidenceSha256: row.after_evidence_sha256,
      runStatus: row.run_status,
      currentStage: row.current_stage,
      acceptedCheckerName: row.accepted_checker_name,
      acceptedCheckerSha256: row.accepted_checker_sha256,
      slotOwnerType: row.slot_owner_type,
      slotOwnerId: row.slot_owner_id,
      slotState: row.slot_state,
      slotVersion: Number(row.slot_version),
      monitorStatus: row.monitor_status,
      monitorLeaseExpiresAt,
      supervisorStatus: row.supervisor_status,
      supervisorLeaseExpiresAt,
    });
  }

  async function getFinalVerifierSnapshot(gate6Id) {
    if (
      typeof gate6Id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gate6Id)
    ) {
      throw new Error("Gate 6 final-verifier ID is invalid");
    }
    const connection = await pool.getConnection();
    try {
      await connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.execute("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
      try {
        const [bindingRows] = await connection.execute(
          `
          SELECT r.gate6_id,
                 r.release_environment,
                 r.runtime_environment,
                 r.drill_mode,
                 r.compose_project,
                 r.candidate_sha,
                 r.candidate_image_digest,
                 r.production_target_descriptor_sha256,
                 r.operator_bundle_sha256,
                 r.status AS run_status,
                 r.current_stage,
                 r.stage_version,
                 r.accepted_checker_name,
                 r.accepted_checker_sha256,
                 r.terminal_evidence_sha256,
                 r.monitor_status,
                 r.monitor_lease_expires_at,
                 r.supervisor_status,
                 r.supervisor_lease_expires_at,
                 r.emergency_supervisor_lease_expires_at,
                 r.expires_at AS run_expires_at,
                 s.owner_type AS slot_owner_type,
                 s.owner_id AS slot_owner_id,
                 s.state AS slot_state,
                 s.version AS slot_version,
                 s.uncompensated_work,
                 s.release_sha AS slot_release_sha,
                 s.target_descriptor_sha256 AS slot_target_descriptor_sha256,
                 s.operator_bundle_sha256 AS slot_operator_bundle_sha256,
                 s.heartbeat_at AS slot_heartbeat_at,
                 s.expires_at AS slot_expires_at
          FROM gate6_runs r
          JOIN gate6_environment_slots s ON s.environment = 'production'
          WHERE r.gate6_id = ?
          LIMIT 2
        `,
          [gate6Id],
        );
        const binding = one(bindingRows, "Gate 6 final-verifier binding");
        if (binding.gate6_id !== gate6Id) {
          throw new Error("Gate 6 final-verifier identity mismatch");
        }
        const [actionRows] = await connection.execute(
          `
          SELECT scope, action_id, kind, paired_action_id,
                 required_stage, required_checker_sha256, status,
                 after_evidence_sha256, completed_at
          FROM gate6_actions
          WHERE gate6_id = ?
          ORDER BY scope, action_id
        `,
          [gate6Id],
        );
        if (!Array.isArray(actionRows)) {
          throw new Error("Gate 6 final-verifier actions are unavailable");
        }
        const [permitRows] = await connection.execute(
          `
          SELECT COUNT(*) AS active_permit_count
          FROM gate6_fault_permits
          WHERE gate6_id = ? AND (status = 'armed' OR status = 'consumed')
        `,
          [gate6Id],
        );
        const permits = one(permitRows, "Gate 6 final-verifier permit count");
        const activePermitCount = Number(permits.active_permit_count);
        if (!Number.isSafeInteger(activePermitCount) || activePermitCount < 0) {
          throw new Error("Gate 6 final-verifier permit count is invalid");
        }
        const stageVersion = Number(binding.stage_version);
        const slotVersion = Number(binding.slot_version);
        const uncompensatedWork = Number(binding.uncompensated_work);
        if (
          !Number.isSafeInteger(stageVersion) ||
          stageVersion < 1 ||
          !Number.isSafeInteger(slotVersion) ||
          slotVersion < 1 ||
          ![0, 1].includes(uncompensatedWork)
        ) {
          throw new Error("Gate 6 final-verifier version or slot state is invalid");
        }
        const iso = (value, label) =>
          new Date(time(value, `Gate 6 final-verifier ${label}`)).toISOString();
        const snapshot = Object.freeze({
          run: Object.freeze({
            gate6Id: binding.gate6_id,
            releaseEnvironment: binding.release_environment,
            runtimeEnvironment: binding.runtime_environment,
            drillMode: binding.drill_mode,
            composeProject: binding.compose_project,
            candidateSha: binding.candidate_sha,
            candidateImageDigest: binding.candidate_image_digest,
            productionTargetDescriptorSha256:
              binding.production_target_descriptor_sha256,
            operatorBundleSha256: binding.operator_bundle_sha256,
            status: binding.run_status,
            currentStage: binding.current_stage,
            stageVersion,
            acceptedCheckerName: binding.accepted_checker_name,
            acceptedCheckerSha256: binding.accepted_checker_sha256,
            terminalEvidenceSha256: binding.terminal_evidence_sha256,
            monitorStatus: binding.monitor_status,
            monitorLeaseExpiresAt: iso(
              binding.monitor_lease_expires_at,
              "monitor lease expiry",
            ),
            supervisorStatus: binding.supervisor_status,
            supervisorLeaseExpiresAt: iso(
              binding.supervisor_lease_expires_at,
              "supervisor lease expiry",
            ),
            emergencySupervisorLeaseExpiresAt: iso(
              binding.emergency_supervisor_lease_expires_at,
              "emergency supervisor lease expiry",
            ),
            expiresAt: iso(binding.run_expires_at, "run expiry"),
          }),
          slot: Object.freeze({
            ownerType: binding.slot_owner_type,
            ownerId: binding.slot_owner_id,
            state: binding.slot_state,
            version: slotVersion,
            uncompensatedWork: uncompensatedWork === 1,
            releaseSha: binding.slot_release_sha,
            targetDescriptorSha256: binding.slot_target_descriptor_sha256,
            operatorBundleSha256: binding.slot_operator_bundle_sha256,
            heartbeatAt: iso(binding.slot_heartbeat_at, "slot heartbeat"),
            expiresAt: iso(binding.slot_expires_at, "slot expiry"),
          }),
          actions: Object.freeze(
            actionRows.map((row) =>
              Object.freeze({
                scope: row.scope,
                actionId: row.action_id,
                kind: row.kind,
                pairedActionId: row.paired_action_id ?? null,
                requiredStage: row.required_stage,
                requiredCheckerSha256: row.required_checker_sha256 ?? null,
                status: row.status,
                afterEvidenceSha256: row.after_evidence_sha256 ?? null,
                completedAt:
                  row.completed_at === null
                    ? null
                    : iso(row.completed_at, "action completion"),
              }),
            ),
          ),
          activePermitCount,
        });
        await connection.commit();
        return snapshot;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    admitInstalledRun,
    beginAction,
    emergencyAbort,
    beginCompensation,
    finishAction,
    acceptSemanticChecker,
    reconcileStaleConsumedActions,
    revokeRun,
    renewLease,
    sealForVerification,
    releaseRun,
    completeRelease,
    completeRollback,
    registerTask9Permit,
    getTask9PermitStatus,
    disarmTask9Permit,
    disarmAllTask9Permits,
    completeTask9PermitAction,
    getActionBinding,
    getAcceptedSemanticBinding,
    getFinalVerifierSnapshot,
    getSanitizedSnapshot,
    getPostProofRestoreAction,
    registerPostProofActions,
    getSupervisorState,
    getWorkerHandoffState,
    getProductionSlotForHandoff,
  });
}
