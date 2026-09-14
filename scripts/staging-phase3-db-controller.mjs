#!/usr/bin/env node

import { phase3PartitionIdentity } from "./lib/phase3-staging-evidence.mjs";

const ACTIONS = new Set([
  "legacy-lease-release",
  "publication-enable",
  "publication-fence",
  "drain-or-quarantine",
  "inline-owner-restore-precheck",
  "inline-owner-restore",
]);
const OBSERVATION_TERMINAL_ACTIONS = Object.freeze({
  "phase3-schema-verify": "staging-gate-3-handoff",
  "phase3-fence-ack-wait": "phase3-publication-fence",
});
const MEASUREMENT_ACTIONS = new Set([
  "phase3-legacy-lease-release",
  "phase3-publication-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
]);
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.:-]*[A-Za-z0-9])?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MEASUREMENT_EPOCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const MIGRATION = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const PUBLICATION_MIGRATION = "035_create_auto_accept_publication_controls.sql";
const FINAL_EVIDENCE_ID = "phase3-gate4-final";
const FINAL_EVIDENCE_TIMEOUT_MS = 5_000;
const FINAL_EVIDENCE_PAYLOAD_FIELDS = Object.freeze([
  "schemaVersion",
  "evidenceId",
  "teamId",
  "epoch",
  "generation",
  "pollerNodeId",
  "expectedOwnerNodeId",
  "windowStartedAt",
  "windowEndedAt",
  "connection",
]);

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string")
  ) return false;
  const expected = new Set(keys);
  if (expected.size !== keys.length) return false;
  for (const key of ownKeys) {
    if (!expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) return false;
  }
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeClone(value) {
  return deepFreeze(structuredClone(value));
}

export function validateStagingPhase3DatabasePayload(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "action",
      "teamId",
      "epoch",
      "pollerNodeId",
      "expectedOwnerNodeId",
      "expectedGeneration",
      "connection",
    ]) ||
    value.schemaVersion !== 1 ||
    !ACTIONS.has(value.action) ||
    ![1, 2].includes(value.teamId) ||
    !ID.test(value.epoch ?? "") ||
    !ID.test(value.pollerNodeId ?? "") ||
    !ID.test(value.expectedOwnerNodeId ?? "") ||
    (["drain-or-quarantine", "inline-owner-restore-precheck", "inline-owner-restore"]
      .includes(value.action)
      ? (!Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1)
      : value.expectedGeneration !== null)
  ) {
    throw new Error("staging Phase 3 database payload or partition is invalid");
  }
  validateConnection(value.connection, "spx_stg_phase3_control");
  return value;
}

function validateConnection(connection, expectedUser) {
  if (
    !exactKeys(connection, ["host", "port", "user", "password", "database", "ssl"]) ||
    !HOST.test(connection.host ?? "") ||
    !Number.isSafeInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65535 ||
    connection.user !== expectedUser ||
    typeof connection.password !== "string" ||
    connection.password.length < 32 ||
    connection.password.length > 4_096 ||
    connection.password.trim() !== connection.password ||
    /[\r\n\0]/.test(connection.password) ||
    connection.database !== "spx_staging" ||
    !exactKeys(connection.ssl, ["ca", "rejectUnauthorized", "servername"]) ||
    typeof connection.ssl.ca !== "string" ||
    connection.ssl.ca.length < 1 ||
    connection.ssl.ca.length > 256 * 1024 ||
    connection.ssl.rejectUnauthorized !== true ||
    !HOST.test(connection.ssl.servername ?? "")
  ) {
    throw new Error("staging Phase 3 control actor connection is invalid");
  }
  return connection;
}

function validateReleaseContext(value) {
  if (
    !exactKeys(value, [
      "candidateSha",
      "imageDigest",
      "releaseManifestSha256",
      "stagingTargetDescriptorSha256",
      "operatorBundleSha256",
      "stagingApprovalEnvelopeSha256",
      "actionJournalHeadSha256",
      "stagingRunId",
      "guardLeaseId",
      "watchdogLeaseId",
      "schema",
      "migrations",
      "rollbackReleaseManifestSha256",
      "rollbackSchema",
      "rollbackMigrations",
    ]) ||
    !COMMIT.test(value.candidateSha ?? "") ||
    !IMAGE.test(value.imageDigest ?? "") ||
    [
      value.releaseManifestSha256,
      value.stagingTargetDescriptorSha256,
      value.operatorBundleSha256,
      value.stagingApprovalEnvelopeSha256,
      value.actionJournalHeadSha256,
      value.rollbackReleaseManifestSha256,
    ].some((hash) => !HASH.test(hash ?? "")) ||
    !CONTEXT_ID.test(value.stagingRunId ?? "") ||
    !CONTEXT_ID.test(value.guardLeaseId ?? "") ||
    !CONTEXT_ID.test(value.watchdogLeaseId ?? "") ||
    value.guardLeaseId === value.watchdogLeaseId ||
    !exactKeys(value.schema, ["min", "max"]) ||
    !Number.isSafeInteger(value.schema.min) ||
    !Number.isSafeInteger(value.schema.max) ||
    value.schema.max < 1 ||
    value.schema.min < 0 ||
    value.schema.min > value.schema.max ||
    !Array.isArray(value.migrations) ||
    value.migrations.length === 0 ||
    !exactKeys(value.rollbackSchema, ["min", "max"]) ||
    !Number.isSafeInteger(value.rollbackSchema.min) ||
    !Number.isSafeInteger(value.rollbackSchema.max) ||
    value.rollbackSchema.min < 0 ||
    value.rollbackSchema.min > value.rollbackSchema.max ||
    value.schema.max < value.rollbackSchema.min ||
    value.schema.max > value.rollbackSchema.max ||
    !Array.isArray(value.rollbackMigrations) ||
    value.rollbackMigrations.length === 0
  ) {
    throw new Error("staging Phase 3 observation release context is invalid");
  }
  const seen = new Set();
  let maximum = -1;
  let publicationMigrationFound = false;
  for (const migration of value.migrations) {
    if (
      !exactKeys(migration, ["filename", "sha256"]) ||
      !MIGRATION.test(migration.filename ?? "") ||
      !HASH.test(migration.sha256 ?? "") ||
      seen.has(migration.filename)
    ) {
      throw new Error("staging Phase 3 observation migration manifest is invalid");
    }
    seen.add(migration.filename);
    maximum = Math.max(maximum, Number(migration.filename.slice(0, 3)));
    if (migration.filename === PUBLICATION_MIGRATION) publicationMigrationFound = true;
  }
  if (!publicationMigrationFound || maximum !== value.schema.max) {
    throw new Error("staging Phase 3 observation schema maximum or migration 035 is invalid");
  }
  const rollbackSeen = new Set();
  let rollbackMaximum = -1;
  for (const migration of value.rollbackMigrations) {
    if (
      !exactKeys(migration, ["filename", "sha256"]) ||
      !MIGRATION.test(migration.filename ?? "") ||
      !HASH.test(migration.sha256 ?? "") ||
      rollbackSeen.has(migration.filename)
    ) {
      throw new Error("staging Phase 3 rollback migration manifest is invalid");
    }
    rollbackSeen.add(migration.filename);
    rollbackMaximum = Math.max(rollbackMaximum, Number(migration.filename.slice(0, 3)));
  }
  if (
    rollbackMaximum !== value.rollbackSchema.max ||
    !rollbackSeen.has(PUBLICATION_MIGRATION)
  ) {
    throw new Error("staging Phase 3 rollback manifest or schema range is invalid");
  }
  const rollbackByFilename = new Map(
    value.rollbackMigrations.map((migration) => [migration.filename, migration.sha256]),
  );
  if (value.migrations.some((migration) =>
    rollbackByFilename.get(migration.filename) !== migration.sha256)) {
    throw new Error("staging Phase 3 rollback migration checksum coverage is incompatible");
  }
  return value;
}

export function validateStagingPhase3ObservationPayload(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "observationId",
      "requiredTerminalActionId",
      "teamId",
      "epoch",
      "pollerNodeId",
      "releaseContext",
      "connection",
    ]) ||
    value.schemaVersion !== 1 ||
    OBSERVATION_TERMINAL_ACTIONS[value.observationId] !== value.requiredTerminalActionId ||
    ![1, 2].includes(value.teamId) ||
    !ID.test(value.epoch ?? "") ||
    !ID.test(value.pollerNodeId ?? "")
  ) {
    throw new Error("staging Phase 3 observation payload is invalid");
  }
  validateReleaseContext(value.releaseContext);
  validateConnection(value.connection, "spx_stg_phase3_observer");
  return value;
}

export function validateStagingPhase3ActionMeasurementPayload(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "actionId",
      "teamId",
      "epoch",
      "expectedGeneration",
      "connection",
    ]) ||
    value.schemaVersion !== 1 ||
    !MEASUREMENT_ACTIONS.has(value.actionId) ||
    ![1, 2].includes(value.teamId) ||
    !MEASUREMENT_EPOCH.test(value.epoch ?? "") ||
    ([
      "phase3-legacy-lease-release",
      "phase3-publication-enable",
      "phase3-publication-fence",
    ].includes(value.actionId)
      ? value.expectedGeneration !== null
      : !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1)
  ) {
    throw new Error("staging Phase 3 action measurement payload is invalid");
  }
  phase3PartitionIdentity(value.teamId, value.epoch);
  validateConnection(value.connection, "spx_stg_phase3_observer");
  return value;
}

function canonicalPayloadTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function validateStagingPhase3EvidencePayload(value, ...extra) {
  if (
    extra.length !== 0 ||
    !exactKeys(value, FINAL_EVIDENCE_PAYLOAD_FIELDS) ||
    value.schemaVersion !== 1 ||
    value.evidenceId !== FINAL_EVIDENCE_ID ||
    ![1, 2].includes(value.teamId) ||
    !MEASUREMENT_EPOCH.test(value.epoch ?? "") ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new Error("staging Phase 3 final evidence payload is invalid");
  }
  const partition = phase3PartitionIdentity(value.teamId, value.epoch);
  if (
    value.pollerNodeId !== partition.pollerNodeId ||
    value.expectedOwnerNodeId !== partition.legacyNodeId
  ) {
    throw new Error("staging Phase 3 final evidence partition is invalid");
  }
  const windowStartedAt = canonicalPayloadTimestamp(
    value.windowStartedAt,
    "staging Phase 3 evidence window start timestamp",
  );
  const windowEndedAt = canonicalPayloadTimestamp(
    value.windowEndedAt,
    "staging Phase 3 evidence window end timestamp",
  );
  if (Date.parse(windowStartedAt) >= Date.parse(windowEndedAt)) {
    throw new Error("staging Phase 3 final evidence window is not strictly ordered");
  }
  validateConnection(value.connection, "spx_stg_phase3_observer");
  return value;
}

function integer(value, label) {
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    number = Number(value);
  } else {
    throw new Error(`${label} is invalid`);
  }
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    Object.is(number, -0)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return number;
}

async function activeRow(connection, input, lock = false) {
  const [rows] = await connection.execute(`
    SELECT active_epoch, active_generation
    FROM auto_accept_publication_active_epochs
    WHERE team_id = ?${lock ? " FOR UPDATE" : ""}
  `, [input.teamId]);
  return rows[0] ?? null;
}

async function controlRow(connection, input, lock = false) {
  const [rows] = await connection.execute(`
    SELECT state, poller_node_id, publication_generation, fence_job_id,
           ack_node_id, ack_job_id, acknowledged_at
    FROM auto_accept_publication_controls
    WHERE team_id = ? AND cutover_epoch = ?${lock ? " FOR UPDATE" : ""}
  `, [input.teamId, input.epoch]);
  return rows[0] ?? null;
}

async function publicationEnable(connection, input) {
  await connection.beginTransaction();
  try {
    const active = await activeRow(connection, input, true);
    let expectedGeneration;
    if (!active) {
      await connection.execute(`
        INSERT INTO auto_accept_publication_controls (
          team_id, cutover_epoch, publication_generation, state, poller_node_id
        ) VALUES (?, ?, 1, 'enabled', ?)
      `, [input.teamId, input.epoch, input.pollerNodeId]);
      await connection.execute(`
        INSERT INTO auto_accept_publication_active_epochs (
          team_id, active_epoch, active_generation
        ) VALUES (?, ?, 1)
      `, [input.teamId, input.epoch]);
      expectedGeneration = 1;
    } else if (active.active_epoch !== input.epoch) {
      const prior = await controlRow(connection, {
        ...input,
        epoch: active.active_epoch,
      }, true);
      const priorGeneration = integer(active.active_generation, "active generation");
      if (
        !prior ||
        integer(prior.publication_generation, "publication generation") !== priorGeneration ||
        !controlFenceAcknowledged(prior, prior.poller_node_id) ||
        !(await drained(connection, {
          ...input,
          epoch: active.active_epoch,
        }, priorGeneration))
      ) {
        throw new Error("staging Phase 3 prior generation is not safe to advance");
      }
      expectedGeneration = priorGeneration + 1;
      await connection.execute(`
        INSERT INTO auto_accept_publication_controls (
          team_id, cutover_epoch, publication_generation, state, poller_node_id
        ) VALUES (?, ?, ?, 'enabled', ?)
      `, [input.teamId, input.epoch, expectedGeneration, input.pollerNodeId]);
      const [advanced] = await connection.execute(`
        UPDATE auto_accept_publication_active_epochs
        SET active_epoch = ?, active_generation = ?
        WHERE team_id = ? AND active_epoch = ? AND active_generation = ?
      `, [
        input.epoch,
        expectedGeneration,
        input.teamId,
        active.active_epoch,
        priorGeneration,
      ]);
      if (Number(advanced?.affectedRows) !== 1) {
        throw new Error("staging Phase 3 active generation advance lost its fence");
      }
    } else {
      expectedGeneration = integer(active.active_generation, "active generation");
    }
    const control = await controlRow(connection, input, true);
    if (
      !control ||
      control.state !== "enabled" ||
      control.poller_node_id !== input.pollerNodeId ||
      integer(control.publication_generation, "publication generation") !== expectedGeneration
    ) throw new Error("staging Phase 3 publication enable postcondition failed");
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

async function publicationFence(connection, input) {
  await connection.beginTransaction();
  try {
    const active = await activeRow(connection, input, true);
    const control = await controlRow(connection, input, true);
    if (
      !active ||
      active.active_epoch !== input.epoch ||
      !control ||
      control.poller_node_id !== input.pollerNodeId ||
      integer(active.active_generation, "active generation") !==
        integer(control.publication_generation, "publication generation")
    ) throw new Error("staging Phase 3 publication identity changed");
    if (control.state === "enabled") {
      const [rows] = await connection.execute(`
        SELECT COALESCE(MAX(id), 0) AS watermark
        FROM auto_accept_jobs
        WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
        FOR UPDATE
      `, [input.teamId, input.epoch, active.active_generation]);
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) {
        throw new Error("staging Phase 3 fence watermark row is invalid");
      }
      await connection.execute(`
        UPDATE auto_accept_publication_controls
        SET state = 'fenced', fence_job_id = ?, fence_requested_at = CURRENT_TIMESTAMP
        WHERE team_id = ? AND cutover_epoch = ? AND state = 'enabled'
      `, [integer(rows[0].watermark, "fence watermark"), input.teamId, input.epoch]);
    } else if (control.state !== "fenced") {
      throw new Error("staging Phase 3 publication state is invalid");
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(connection, input, predicate, failure) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await predicate(connection, input)) return;
    await delay(500);
  }
  throw new Error(failure);
}

async function leaseMatches(connection, input, expected) {
  const [rows] = await connection.execute(`
    SELECT owner_node_id, status, lease_expires_at > CURRENT_TIMESTAMP AS lease_active
    FROM team_runtime_leases WHERE team_id = ?
  `, [input.teamId]);
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("staging Phase 3 lease row is invalid");
  }
  if (rows.length === 0) return !expected;
  const row = rows[0];
  if (!row || typeof row !== "object") {
    throw new Error("staging Phase 3 lease row is invalid");
  }
  const leaseActive = integer(row.lease_active, "lease active");
  if (leaseActive !== 0 && leaseActive !== 1) {
    throw new Error("lease active is invalid");
  }
  if (leaseActive === 0) return !expected;
  if (row.status !== "running") {
    throw new Error("staging Phase 3 live lease status is invalid");
  }
  return expected ? row.owner_node_id === input.expectedOwnerNodeId : false;
}

function controlFenceAcknowledged(control, pollerNodeId) {
  return Boolean(
    control &&
    control.state === "fenced" &&
    control.poller_node_id === pollerNodeId &&
    control.ack_node_id === pollerNodeId &&
    control.acknowledged_at &&
    integer(control.ack_job_id, "ack watermark") >= integer(control.fence_job_id, "fence watermark"),
  );
}

async function drained(connection, input, generation) {
  const [rows] = await connection.execute(`
    SELECT
      COALESCE(SUM(status IN ('pending','retrying','claimed','verifying','indeterminate')), 0) AS active_count,
      COALESCE(SUM(result_status = 'unknown'), 0) AS unknown_count,
      COALESCE(SUM(result_status IS NOT NULL AND completed_at IS NULL), 0) AS settlement_pending
    FROM auto_accept_jobs
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
  `, [input.teamId, input.epoch, generation]);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error("staging Phase 3 drain aggregate row is invalid");
  }
  const row = rows[0];
  return [row.active_count, row.unknown_count, row.settlement_pending]
    .every((value) => integer(value, "drain count") === 0);
}

async function observeSchema(connection, input) {
  const [rows] = await connection.execute(`
    SELECT name, checksum_sha256, status
    FROM schema_migrations
    WHERE name REGEXP '^[0-9]{3}_[a-z0-9_]+\\.sql$'
    ORDER BY name
  `, []);
  if (!Array.isArray(rows)) {
    throw new Error("staging migration history rows are invalid");
  }
  const statusCounts = { pending: 0, running: 0, failed: 0 };
  for (const row of rows) {
    if (
      !exactKeys(row, ["name", "checksum_sha256", "status"]) ||
      !MIGRATION.test(row.name ?? "") ||
      !HASH.test(row.checksum_sha256 ?? "") ||
      !["applied", "pending", "running", "failed"].includes(row.status)
    ) {
      throw new Error("staging migration history row is invalid");
    }
    if (Object.hasOwn(statusCounts, row.status)) statusCounts[row.status] += 1;
  }
  const installed = new Map(rows.map((row) => [row.name, row]));
  if (installed.size !== rows.length) {
    throw new Error("staging migration history contains a duplicate migration");
  }
  const verifyMigrations = (migrations, label) => {
    for (const migration of migrations) {
      const row = installed.get(migration.filename);
      if (
        !row ||
        row.checksum_sha256 !== migration.sha256 ||
        row.status !== "applied"
      ) {
        throw new Error(`${label} staging migration is pending, running, failed, or changed`);
      }
    }
  };
  verifyMigrations(input.releaseContext.migrations, "candidate release");
  verifyMigrations(input.releaseContext.rollbackMigrations, "rollback release");
  if (rows.some((row) => row.status !== "applied")) {
    throw new Error("staging migration history contains a non-applied row");
  }
  const installedMaximum = Math.max(
    -1,
    ...rows
      .filter((row) => MIGRATION.test(row.name ?? ""))
      .map((row) => Number(row.name.slice(0, 3))),
  );
  if (installedMaximum !== input.releaseContext.schema.max) {
    throw new Error("installed staging schema maximum changed");
  }
  const publication = installed.get(PUBLICATION_MIGRATION);
  const expectedPublication = input.releaseContext.migrations.find(
    (migration) => migration.filename === PUBLICATION_MIGRATION,
  );
  if (
    !publication ||
    !expectedPublication ||
    publication.checksum_sha256 !== expectedPublication.sha256 ||
    publication.status !== "applied"
  ) {
    throw new Error("installed migration 035 manifest binding changed");
  }
  if (statusCounts.pending !== 0 || statusCounts.running !== 0 || statusCounts.failed !== 0) {
    throw new Error("staging migration history contains pending, running, or failed rows");
  }
  return {
    candidateSchemaVersion: input.releaseContext.schema.max,
    schemaMaximum: input.releaseContext.schema.max,
    rollbackSchemaMinimum: input.releaseContext.rollbackSchema.min,
    rollbackSchemaMaximum: input.releaseContext.rollbackSchema.max,
    candidateSchemaRangeDeclared: true,
    nMinusOneSchemaRangeDeclared: true,
    migration035ChecksumMatches: true,
    pendingMigrations: statusCounts.pending,
    runningMigrations: statusCounts.running,
    failedMigrations: statusCounts.failed,
    observerReadOnly: true,
  };
}

async function observeFenceAcknowledgement(connection, input) {
  const [rows] = await connection.execute(`
    SELECT team_id, cutover_epoch, publication_generation, state,
           poller_node_id, fence_job_id, ack_node_id, ack_job_id,
           acknowledged_at, is_active, active_epoch, active_generation
    FROM operational_phase3_control_evidence
    WHERE team_id = ? AND cutover_epoch = ?
  `, [input.teamId, input.epoch]);
  const row = oneRow(rows, "staging Phase 3 fence acknowledgment observation");
  if (!exactKeys(row, [
    "team_id",
    "cutover_epoch",
    "publication_generation",
    "state",
    "poller_node_id",
    "fence_job_id",
    "ack_node_id",
    "ack_job_id",
    "acknowledged_at",
    "is_active",
    "active_epoch",
    "active_generation",
  ])) throw new Error("staging Phase 3 fence acknowledgment row is invalid");
  const publicationGeneration = integer(
    row.publication_generation,
    "publication generation",
  );
  const activeGeneration = integer(row.active_generation, "active generation");
  const fenceJobId = integer(row.fence_job_id, "fence watermark");
  const ackJobId = integer(row.ack_job_id, "ack watermark");
  const isActive = integer(row.is_active, "active flag");
  if (
    publicationGeneration < 1 ||
    row.team_id !== input.teamId ||
    row.cutover_epoch !== input.epoch ||
    row.state !== "fenced" ||
    row.poller_node_id !== input.pollerNodeId ||
    row.ack_node_id !== input.pollerNodeId ||
    isActive !== 1 ||
    row.active_epoch !== input.epoch ||
    activeGeneration !== publicationGeneration ||
    ackJobId < fenceJobId
  ) {
    throw new Error("publication fence acknowledgment tuple changed");
  }
  return {
    state: "fenced",
    publicationGeneration,
    fenceJobId,
    ackJobId,
    pollerNodeId: input.pollerNodeId,
    ackNodeId: input.pollerNodeId,
    acknowledgedAt: canonicalTimestamp(
      row.acknowledged_at,
      "fence acknowledgment time",
    ),
    isActive: true,
    observerReadOnly: true,
  };
}

function oneRow(rows, label) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== "object" ||
    Array.isArray(rows[0])
  ) {
    throw new Error(`${label} row is invalid`);
  }
  return rows[0];
}

function canonicalTimestamp(value, label) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.valueOf())) throw new Error(`${label} is invalid`);
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
      throw new Error(`${label} is invalid`);
    }
    return value;
  }
  throw new Error(`${label} is invalid`);
}

async function collectActionControl(connection, input, partition) {
  const [rows] = await connection.execute(`
    SELECT team_id, cutover_epoch, publication_generation, state,
           poller_node_id, fence_job_id, ack_node_id, ack_job_id,
           acknowledged_at, is_active, active_epoch, active_generation
    FROM operational_phase3_control_evidence
    WHERE team_id = ? AND cutover_epoch = ?
  `, [input.teamId, input.epoch]);
  const row = oneRow(rows, "staging Phase 3 control evidence");
  const publicationGeneration = integer(
    row.publication_generation,
    "publication generation",
  );
  const activeGeneration = integer(row.active_generation, "active generation");
  const isActive = integer(row.is_active, "active flag");
  if (
    row.team_id !== input.teamId ||
    row.cutover_epoch !== input.epoch ||
    row.poller_node_id !== partition.pollerNodeId ||
    publicationGeneration < 1 ||
    activeGeneration < 1 ||
    publicationGeneration !== activeGeneration ||
    isActive !== 1 ||
    row.active_epoch !== input.epoch ||
    (["phase3-drain-or-quarantine", "phase3-inline-owner-restore"].includes(input.actionId) &&
      publicationGeneration !== input.expectedGeneration)
  ) {
    throw new Error("staging Phase 3 control identity is invalid");
  }

  if (input.actionId === "phase3-publication-enable") {
    if (
      row.state !== "enabled" ||
      row.fence_job_id !== null ||
      row.ack_node_id !== null ||
      row.ack_job_id !== null ||
      row.acknowledged_at !== null
    ) {
      throw new Error("staging Phase 3 enabled control postcondition is invalid");
    }
    return {
      state: "enabled",
      pollerNodeId: partition.pollerNodeId,
      isActive: true,
      activeEpoch: input.epoch,
      activeGeneration,
      publicationGeneration,
      fenceJobId: null,
      ackNodeId: null,
      ackJobId: null,
      acknowledgedAt: null,
    };
  }

  if (row.state !== "fenced") {
    throw new Error("staging Phase 3 fenced control postcondition is invalid");
  }
  const fenceJobId = integer(row.fence_job_id, "fence watermark");
  const acknowledgement = [row.ack_node_id, row.ack_job_id, row.acknowledged_at];
  const acknowledgementAbsent = acknowledgement.every((value) => value === null);
  const acknowledgementPresent = acknowledgement.every(
    (value) => value !== null && value !== undefined,
  );
  if (!acknowledgementAbsent && !acknowledgementPresent) {
    throw new Error("staging Phase 3 acknowledgment tuple is partial");
  }
  let ackNodeId = null;
  let ackJobId = null;
  let acknowledgedAt = null;
  if (acknowledgementPresent) {
    ackNodeId = row.ack_node_id;
    ackJobId = integer(row.ack_job_id, "ack watermark");
    acknowledgedAt = canonicalTimestamp(row.acknowledged_at, "acknowledged timestamp");
    if (ackNodeId !== partition.pollerNodeId || ackJobId < fenceJobId) {
      throw new Error("staging Phase 3 acknowledgment tuple is incoherent");
    }
  }
  if (
    ["phase3-drain-or-quarantine", "phase3-inline-owner-restore"].includes(input.actionId) &&
    !acknowledgementPresent
  ) {
    throw new Error("staging Phase 3 acknowledgment tuple is required");
  }
  return {
    state: "fenced",
    pollerNodeId: partition.pollerNodeId,
    isActive: true,
    activeEpoch: input.epoch,
    activeGeneration,
    publicationGeneration,
    fenceJobId,
    ackNodeId,
    ackJobId,
    acknowledgedAt,
  };
}

async function collectActionDrain(connection, input, generation) {
  const [rows] = await connection.execute(`
    SELECT
      COALESCE(SUM(status IN ('pending', 'retrying')), 0) AS queued,
      COALESCE(SUM(status IN ('claimed', 'verifying')), 0) AS live_claims,
      COALESCE(SUM(status = 'indeterminate'), 0) AS indeterminate,
      COALESCE(SUM(
        result_status = 'unknown'
        OR status NOT IN (
          'pending', 'retrying', 'claimed', 'verifying', 'succeeded',
          'failed', 'indeterminate', 'dead_letter', 'cancelled'
        )
      ), 0) AS unknown_count,
      COALESCE(SUM(
        result_status IS NOT NULL
        AND status NOT IN ('succeeded', 'failed', 'indeterminate', 'dead_letter', 'cancelled')
      ), 0) AS settlement_pending
    FROM operational_phase3_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
  `, [input.teamId, input.epoch, generation]);
  const row = oneRow(rows, "staging Phase 3 drain evidence");
  const drain = {
    queued: integer(row.queued, "queued drain count"),
    liveClaims: integer(row.live_claims, "live claim drain count"),
    indeterminate: integer(row.indeterminate, "indeterminate drain count"),
    unknown: integer(row.unknown_count, "unknown drain count"),
    settlementPending: integer(row.settlement_pending, "settlement drain count"),
  };
  if (Object.values(drain).some((count) => count !== 0)) {
    throw new Error("staging Phase 3 drain postcondition is not zero");
  }
  return drain;
}

async function collectActionLease(connection, input, partition) {
  const [rows] = await connection.execute(`
    SELECT owner_node_id, status,
           lease_expires_at > CURRENT_TIMESTAMP AS lease_active
    FROM team_runtime_leases
    WHERE team_id = ?
  `, [input.teamId]);
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("staging Phase 3 lease evidence row is invalid");
  }
  if (rows.length === 0) {
    if (input.actionId === "phase3-inline-owner-restore") {
      throw new Error("staging Phase 3 inline lease is missing");
    }
    return { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false };
  }
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("staging Phase 3 lease evidence row is invalid");
  }
  const leaseActive = integer(row.lease_active, "lease active");
  if (leaseActive !== 0 && leaseActive !== 1) {
    throw new Error("lease active is invalid");
  }
  if (leaseActive === 0) {
    if (input.actionId === "phase3-inline-owner-restore") {
      throw new Error("staging Phase 3 inline lease is expired");
    }
    return { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false };
  }
  if (row.status !== "running") {
    throw new Error("staging Phase 3 live lease status is invalid");
  }
  if (input.actionId === "phase3-legacy-lease-release") {
    throw new Error("staging Phase 3 legacy lease remains active");
  }
  if (row.owner_node_id !== partition.legacyNodeId) {
    throw new Error("staging Phase 3 inline lease owner is invalid");
  }
  return {
    activeOwnerCount: 1,
    ownerNodeId: partition.legacyNodeId,
    status: "active",
  };
}

const FINAL_EVIDENCE_SQL = Object.freeze({
  isolation: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  snapshot: "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
  control: `
    SELECT state, publication_generation, fence_job_id, ack_job_id,
           poller_node_id, ack_node_id, acknowledged_at,
           is_active, active_epoch, active_generation
    FROM operational_phase3_control_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
  `,
  drain: `
    SELECT
      COALESCE(SUM(status IN ('pending', 'retrying')), 0) AS queued,
      COALESCE(SUM(status IN ('claimed', 'verifying')), 0) AS live_claims,
      COALESCE(SUM(status = 'indeterminate'), 0) AS indeterminate,
      COALESCE(SUM(
        result_status = 'unknown'
        OR status NOT IN (
          'pending', 'retrying', 'claimed', 'verifying', 'succeeded',
          'failed', 'indeterminate', 'dead_letter', 'cancelled'
        )
      ), 0) AS unknown_count,
      COALESCE(SUM(
        result_status IS NOT NULL
        AND status NOT IN ('succeeded', 'failed', 'indeterminate', 'dead_letter', 'cancelled')
      ), 0) AS settlement_pending
    FROM operational_phase3_evidence
    WHERE team_id = ? AND cutover_epoch = ? AND publication_generation = ?
  `,
  externalAttempts: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN auto_accept_attempts AS a
        ON a.team_id = j.team_id
       AND REGEXP_LIKE(
         a.trace_id,
         CONCAT('^aa-job:', CAST(j.id AS CHAR), ':external:[1-9][0-9]*$'),
         'c'
       )
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  results: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, r.booking_id, r.request_id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN auto_accept_results AS r
        ON r.team_id = j.team_id
       AND r.booking_id <=> j.booking_id
       AND r.request_id <=> j.request_id
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id, r.booking_id, r.request_id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  history: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, h.booking_id, h.rule_id, h.trace_id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN auto_accept_history AS h
        ON h.team_id = j.team_id
       AND h.booking_id <=> j.booking_id
       AND h.rule_id <=> j.rule_id
       AND BINARY h.trace_id = BINARY j.winning_attempt_trace_id
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id, h.booking_id, h.rule_id, h.trace_id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  bookingHistory: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, h.request_id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN spx_booking_history AS h
        ON h.team_id = j.team_id
       AND h.request_id <=> j.request_id
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id, h.request_id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  notifications: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, n.trace_id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN notification_events AS n
        ON n.team_id = j.team_id
       AND BINARY n.trace_id = BINARY j.winning_attempt_trace_id
       AND n.event_type = 'auto_accept_result'
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id, n.trace_id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  budgetReservations: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN auto_accept_job_settlements AS s
        ON s.team_id = j.team_id
       AND s.job_id = j.id
       AND s.settlement_step = 'budget_reservation'
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  settlements: `
    SELECT COALESCE(SUM(grouped.row_count - 1), 0) AS excess_count
    FROM (
      SELECT j.id, s.settlement_step, COUNT(*) AS row_count
      FROM auto_accept_jobs AS j
      INNER JOIN auto_accept_job_settlements AS s
        ON s.team_id = j.team_id
       AND s.job_id = j.id
      WHERE j.team_id = ?
        AND j.cutover_epoch = ?
        AND j.publication_generation = ?
      GROUP BY j.id, s.settlement_step
      HAVING COUNT(*) > 1
    ) AS grouped
  `,
  staleEpochActions: `
    SELECT COUNT(*) AS anomaly_count
    FROM auto_accept_jobs AS j
    WHERE j.team_id = ?
      AND j.created_at >= ? AND j.created_at <= ?
      AND j.cutover_epoch IS NOT NULL
      AND j.publication_generation IS NOT NULL
      AND (j.cutover_epoch <> ? OR j.publication_generation <> ?)
      AND (
        j.status IN ('pending', 'retrying', 'claimed', 'verifying')
        OR j.winning_attempt_trace_id IS NOT NULL
        OR j.result_status IS NOT NULL
        OR j.completed_at IS NOT NULL
      )
  `,
  directPollerAccepts: `
    SELECT COUNT(*) AS direct_count
    FROM auto_accept_attempts AS a
    WHERE a.team_id = ?
      AND a.worker_node_id = ?
      AND a.created_at >= ?
  `,
  inlineLease: `
    SELECT COUNT(*) AS active_owner_count,
           CASE WHEN COUNT(*) = 1 THEN MAX(owner_node_id) ELSE NULL END AS owner_node_id
    FROM team_runtime_leases
    WHERE team_id = ?
      AND status = 'running'
      AND lease_expires_at > CURRENT_TIMESTAMP
  `,
  commit: "COMMIT",
  rollback: "ROLLBACK",
});

function finalEvidenceExecute(connection, sql, values = []) {
  return connection.execute({
    sql,
    values,
    timeout: FINAL_EVIDENCE_TIMEOUT_MS,
  });
}

async function finalEvidenceRows(connection, sql, values) {
  const [rows] = await finalEvidenceExecute(connection, sql, values);
  return rows;
}

function exactFinalRow(rows, fields, label) {
  const row = oneRow(rows, label);
  if (!exactKeys(row, fields)) throw new Error(`${label} row is invalid`);
  return row;
}

function finalScalarCount(rows, field, label) {
  const row = exactFinalRow(rows, [field], label);
  return integer(row[field], label);
}

function floorUtcSecond(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

async function collectFinalControl(connection, input, currentValues) {
  const row = exactFinalRow(
    await finalEvidenceRows(connection, FINAL_EVIDENCE_SQL.control, currentValues),
    [
      "state",
      "publication_generation",
      "fence_job_id",
      "ack_job_id",
      "poller_node_id",
      "ack_node_id",
      "acknowledged_at",
      "is_active",
      "active_epoch",
      "active_generation",
    ],
    "staging Phase 3 final control evidence",
  );
  const generation = integer(row.publication_generation, "final publication generation");
  const activeGeneration = integer(row.active_generation, "final active generation");
  const fenceJobId = integer(row.fence_job_id, "final fence job ID");
  const ackJobId = integer(row.ack_job_id, "final acknowledgement job ID");
  const isActive = integer(row.is_active, "final active flag");
  if (
    row.state !== "fenced" ||
    generation !== input.generation ||
    activeGeneration !== input.generation ||
    row.active_epoch !== input.epoch ||
    isActive !== 1 ||
    row.poller_node_id !== input.pollerNodeId ||
    row.ack_node_id !== input.pollerNodeId ||
    ackJobId < fenceJobId
  ) {
    throw new Error("staging Phase 3 final control tuple is invalid");
  }
  return {
    state: "fenced",
    generation,
    fenceJobId,
    ackJobId,
    pollerNodeMatches: true,
    acknowledgedAt: canonicalTimestamp(
      row.acknowledged_at,
      "final fence acknowledgement timestamp",
    ),
  };
}

async function collectFinalDrain(connection, currentValues) {
  const row = exactFinalRow(
    await finalEvidenceRows(connection, FINAL_EVIDENCE_SQL.drain, currentValues),
    ["queued", "live_claims", "indeterminate", "unknown_count", "settlement_pending"],
    "staging Phase 3 final drain evidence",
  );
  return {
    queued: integer(row.queued, "final queued count"),
    liveClaims: integer(row.live_claims, "final live claim count"),
    indeterminate: integer(row.indeterminate, "final indeterminate count"),
    unknown: integer(row.unknown_count, "final unknown count"),
    settlementPending: integer(row.settlement_pending, "final settlement pending count"),
  };
}

async function collectFinalDuplicate(connection, sql, currentValues, label) {
  return finalScalarCount(
    await finalEvidenceRows(connection, sql, currentValues),
    "excess_count",
    `staging Phase 3 ${label} excess count`,
  );
}

async function collectFinalInlineLease(connection, input) {
  const row = exactFinalRow(
    await finalEvidenceRows(connection, FINAL_EVIDENCE_SQL.inlineLease, [input.teamId]),
    ["active_owner_count", "owner_node_id"],
    "staging Phase 3 final inline lease evidence",
  );
  const activeOwnerCount = integer(row.active_owner_count, "final active owner count");
  if (activeOwnerCount !== 1 || row.owner_node_id !== input.expectedOwnerNodeId) {
    throw new Error("staging Phase 3 final inline lease owner is invalid");
  }
  return {
    activeOwnerCount,
    ownerNodeId: input.expectedOwnerNodeId,
    ownerMatches: true,
  };
}

async function collectFinalEvidence(connection, input) {
  const currentValues = [input.teamId, input.epoch, input.generation];
  const windowStartedAt = floorUtcSecond(input.windowStartedAt);
  const windowEndedAt = floorUtcSecond(input.windowEndedAt);
  const control = await collectFinalControl(connection, input, currentValues);
  const drain = await collectFinalDrain(connection, currentValues);
  const duplicates = {
    externalAttempts: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.externalAttempts,
      currentValues,
      "external attempt",
    ),
    results: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.results,
      currentValues,
      "result",
    ),
    history: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.history,
      currentValues,
      "history",
    ),
    bookingHistory: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.bookingHistory,
      currentValues,
      "booking history",
    ),
    notifications: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.notifications,
      currentValues,
      "notification",
    ),
    budgetReservations: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.budgetReservations,
      currentValues,
      "budget reservation",
    ),
    settlements: await collectFinalDuplicate(
      connection,
      FINAL_EVIDENCE_SQL.settlements,
      currentValues,
      "settlement",
    ),
  };
  const staleEpochActions = finalScalarCount(
    await finalEvidenceRows(connection, FINAL_EVIDENCE_SQL.staleEpochActions, [
      input.teamId,
      windowStartedAt,
      windowEndedAt,
      input.epoch,
      input.generation,
    ]),
    "anomaly_count",
    "staging Phase 3 stale epoch action count",
  );
  const directPollerAccepts = finalScalarCount(
    await finalEvidenceRows(connection, FINAL_EVIDENCE_SQL.directPollerAccepts, [
      input.teamId,
      input.pollerNodeId,
      windowStartedAt,
    ]),
    "direct_count",
    "staging Phase 3 direct poller attempt count",
  );
  const inlineLease = await collectFinalInlineLease(connection, input);
  return {
    ok: true,
    evidenceId: FINAL_EVIDENCE_ID,
    control,
    drain,
    duplicates,
    staleEpochActions,
    directPollerAccepts,
    inlineLease,
  };
}

export async function executeStagingPhase3EvidencePayload(value, mysql, ...extra) {
  if (extra.length !== 0) {
    throw new Error("staging Phase 3 final evidence executor accepts no overrides");
  }
  const input = validateStagingPhase3EvidencePayload(value);
  const connection = await mysql.createConnection(input.connection);
  let primaryError;
  let result;
  try {
    await finalEvidenceExecute(connection, FINAL_EVIDENCE_SQL.isolation);
    await finalEvidenceExecute(connection, FINAL_EVIDENCE_SQL.snapshot);
    result = await collectFinalEvidence(connection, input);
    await finalEvidenceExecute(connection, FINAL_EVIDENCE_SQL.commit);
  } catch (error) {
    primaryError = error;
    try {
      await finalEvidenceExecute(connection, FINAL_EVIDENCE_SQL.rollback);
    } catch {
      // The original query, timeout, commit, or validation error remains authoritative.
    }
  }
  try {
    await connection.end();
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  if (primaryError) throw primaryError;
  return freezeClone(result);
}

export async function executeStagingPhase3ActionMeasurementPayload(value, mysql) {
  const input = validateStagingPhase3ActionMeasurementPayload(value);
  const partition = phase3PartitionIdentity(input.teamId, input.epoch);
  const connection = await mysql.createConnection(input.connection);
  try {
    if (input.actionId === "phase3-legacy-lease-release") {
      return {
        ok: true,
        actionId: input.actionId,
        teamId: input.teamId,
        epoch: input.epoch,
        generation: null,
        measurements: { lease: await collectActionLease(connection, input, partition) },
      };
    }

    const control = await collectActionControl(connection, input, partition);
    const generation = control.publicationGeneration;
    if (
      input.actionId === "phase3-publication-enable" ||
      input.actionId === "phase3-publication-fence"
    ) {
      return {
        ok: true,
        actionId: input.actionId,
        teamId: input.teamId,
        epoch: input.epoch,
        generation,
        measurements: { control },
      };
    }

    const drain = await collectActionDrain(connection, input, generation);
    if (input.actionId === "phase3-drain-or-quarantine") {
      return {
        ok: true,
        actionId: input.actionId,
        teamId: input.teamId,
        epoch: input.epoch,
        generation: input.expectedGeneration,
        measurements: { control, drain },
      };
    }
    const lease = await collectActionLease(connection, input, partition);
    return {
      ok: true,
      actionId: input.actionId,
      teamId: input.teamId,
      epoch: input.epoch,
      generation: input.expectedGeneration,
      measurements: { control, drain, lease },
    };
  } finally {
    await connection.end();
  }
}

function observationTimestamp(options) {
  if (
    !exactKeys(options, Object.hasOwn(options ?? {}, "now") ? ["now"] : []) ||
    (options.now !== undefined && typeof options.now !== "function")
  ) throw new Error("staging Phase 3 observation clock is invalid");
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("staging Phase 3 observation clock is invalid");
  }
  return new Date(nowMs).toISOString();
}

export async function executeStagingPhase3ObservationPayload(value, mysql, options = {}) {
  const input = validateStagingPhase3ObservationPayload(value);
  const connection = await mysql.createConnection(input.connection);
  let generation = null;
  let measurements;
  let observedAt;
  try {
    if (input.observationId === "phase3-schema-verify") {
      measurements = await observeSchema(connection, input);
    } else {
      measurements = await observeFenceAcknowledgement(connection, input);
      generation = measurements.publicationGeneration;
    }
    observedAt = observationTimestamp(options);
  } finally {
    await connection.end();
  }
  return {
    ok: true,
    observationId: input.observationId,
    requiredTerminalActionId: input.requiredTerminalActionId,
    teamId: input.teamId,
    epoch: input.epoch,
    pollerNodeId: input.pollerNodeId,
    generation,
    observedAt,
    measurements,
  };
}

async function requireSafeGeneration(connection, input, lock = false) {
  const active = await activeRow(connection, input, lock);
  const control = await controlRow(connection, input, lock);
  const generation = integer(control?.publication_generation, "publication generation");
  if (
    !active ||
    active.active_epoch !== input.epoch ||
    integer(active.active_generation, "active generation") !== input.expectedGeneration ||
    generation !== input.expectedGeneration ||
    !controlFenceAcknowledged(control, input.pollerNodeId) ||
    !(await drained(connection, input, generation))
  ) {
    throw new Error("Phase 3 generation is not fenced, acknowledged, and drained");
  }
  return generation;
}

async function requireSafeGenerationTransaction(connection, input) {
  await connection.beginTransaction();
  try {
    const generation = await requireSafeGeneration(connection, input, true);
    await connection.commit();
    return generation;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  }
}

export async function executeStagingPhase3DatabasePayload(value, mysql) {
  const input = validateStagingPhase3DatabasePayload(value);
  const connection = await mysql.createConnection(input.connection);
  try {
    if (input.action === "publication-enable") await publicationEnable(connection, input);
    else if (input.action === "publication-fence") await publicationFence(connection, input);
    else if (input.action === "legacy-lease-release") {
      await waitFor(connection, input, (db, current) => leaseMatches(db, current, false), "legacy lease remains active");
    } else if (input.action === "inline-owner-restore-precheck") {
      await requireSafeGenerationTransaction(connection, input);
    } else if (input.action === "inline-owner-restore") {
      const generation = await requireSafeGenerationTransaction(connection, input);
      await waitFor(connection, input, (db, current) => leaseMatches(db, current, true), "inline owner was not restored");
      const restoredGeneration = await requireSafeGenerationTransaction(connection, input);
      if (restoredGeneration !== generation) {
        throw new Error("Phase 3 active generation pointer changed during inline restoration");
      }
    } else if (input.action === "drain-or-quarantine") {
      await requireSafeGenerationTransaction(connection, input);
    }
  } finally {
    await connection.end();
  }
  return { ok: true, action: input.action };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("staging Phase 3 payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  if (process.argv.length !== 2) throw new Error("staging Phase 3 DB controller accepts zero arguments");
  const mysql = await import("mysql2/promise");
  const payload = await readStdin();
  const result = Object.hasOwn(payload, "evidenceId")
    ? await executeStagingPhase3EvidencePayload(payload, mysql)
    : Object.hasOwn(payload, "observationId")
      ? await executeStagingPhase3ObservationPayload(payload, mysql)
      : Object.hasOwn(payload, "actionId")
        ? await executeStagingPhase3ActionMeasurementPayload(payload, mysql)
        : await executeStagingPhase3DatabasePayload(payload, mysql);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]?.endsWith("staging-phase3-db-controller.mjs")) {
  main().catch(() => {
    process.stdout.write('{"code":"staging-phase3-db-refused","ok":false}\n');
    process.exitCode = 1;
  });
}
