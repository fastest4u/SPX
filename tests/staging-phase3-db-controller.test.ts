import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  executeStagingPhase3ActionMeasurementPayload,
  executeStagingPhase3DatabasePayload,
  executeStagingPhase3EvidencePayload,
  executeStagingPhase3ObservationPayload,
  validateStagingPhase3ActionMeasurementPayload,
  validateStagingPhase3DatabasePayload,
  validateStagingPhase3EvidencePayload,
  validateStagingPhase3ObservationPayload,
} from "../scripts/staging-phase3-db-controller.mjs";

const payload = {
  schemaVersion: 1,
  action: "publication-fence",
  teamId: 2,
  epoch: "phase3-ifn-001",
  pollerNodeId: "stg-poller-ifn-phase3-1",
  expectedOwnerNodeId: "stg-worker-ifn-split-1",
  expectedGeneration: null,
  connection: {
    host: "mysql.staging.internal",
    port: 3306,
    user: "spx_stg_phase3_control",
    password: "x".repeat(40),
    database: "spx_staging",
    ssl: { ca: "test-ca", rejectUnauthorized: true, servername: "mysql.staging.internal" },
  },
};
const releaseContext = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  stagingTargetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  stagingApprovalEnvelopeSha256: "f".repeat(64),
  actionJournalHeadSha256: "1".repeat(64),
  stagingRunId: "staging-run-001",
  guardLeaseId: "guard-001",
  watchdogLeaseId: "watchdog-001",
  schema: { min: 36, max: 37 },
  rollbackReleaseManifestSha256: "5".repeat(64),
  rollbackSchema: { min: 35, max: 37 },
  rollbackMigrations: [
    { filename: "035_create_auto_accept_publication_controls.sql", sha256: "2".repeat(64) },
    { filename: "036_create_gate6_control_plane.sql", sha256: "3".repeat(64) },
    { filename: "037_create_n_minus_one_probe_fixtures.sql", sha256: "4".repeat(64) },
  ],
  migrations: [
    { filename: "035_create_auto_accept_publication_controls.sql", sha256: "2".repeat(64) },
    { filename: "036_create_gate6_control_plane.sql", sha256: "3".repeat(64) },
    { filename: "037_create_n_minus_one_probe_fixtures.sql", sha256: "4".repeat(64) },
  ],
};
const observerConnection = {
  ...payload.connection,
  user: "spx_stg_phase3_observer",
};
const OBSERVED_MS = Date.parse("2026-07-12T10:31:00.000Z");
const observationClock = { now: () => OBSERVED_MS };

const measurementActionIds = [
  "phase3-legacy-lease-release",
  "phase3-publication-enable",
  "phase3-publication-fence",
  "phase3-drain-or-quarantine",
  "phase3-inline-owner-restore",
] as const;
type MeasurementActionId = (typeof measurementActionIds)[number];

const identities = {
  1: {
    pollerNodeId: "stg-poller-ptwl-phase3-1",
    legacyNodeId: "stg-worker-ptwl-split-1",
  },
  2: {
    pollerNodeId: "stg-poller-ifn-phase3-1",
    legacyNodeId: "stg-worker-ifn-split-1",
  },
} as const;

const expectedGenerationByAction: Record<MeasurementActionId, number | null> = {
  "phase3-legacy-lease-release": null,
  "phase3-publication-enable": null,
  "phase3-publication-fence": null,
  "phase3-drain-or-quarantine": 7,
  "phase3-inline-owner-restore": 7,
};

function measurementPayload(
  actionId: MeasurementActionId,
  teamId: 1 | 2 = 2,
  epoch = `phase3-${teamId === 1 ? "ptwl" : "ifn"}-001`,
) {
  return {
    schemaVersion: 1,
    actionId,
    teamId,
    epoch,
    expectedGeneration: expectedGenerationByAction[actionId],
    connection: { ...observerConnection, ssl: { ...observerConnection.ssl } },
  };
}

const finalEvidencePayload = {
  schemaVersion: 1,
  evidenceId: "phase3-gate4-final",
  teamId: 2,
  epoch: "phase3-ifn-001",
  generation: 7,
  pollerNodeId: identities[2].pollerNodeId,
  expectedOwnerNodeId: identities[2].legacyNodeId,
  windowStartedAt: "2026-07-12T09:59:59.987Z",
  windowEndedAt: "2026-07-12T10:00:07.654Z",
  connection: { ...observerConnection, ssl: { ...observerConnection.ssl } },
};

function finalEvidenceResultRows() {
  return [
    [{
      state: "fenced",
      publication_generation: 7,
      fence_job_id: 40,
      ack_job_id: 41,
      poller_node_id: identities[2].pollerNodeId,
      ack_node_id: identities[2].pollerNodeId,
      acknowledged_at: "2026-07-12T10:00:05.000Z",
      is_active: 1,
      active_epoch: finalEvidencePayload.epoch,
      active_generation: 7,
    }],
    [{
      queued: 1,
      live_claims: 2,
      indeterminate: 3,
      unknown_count: 4,
      settlement_pending: 5,
    }],
    [{ excess_count: 6 }],
    [{ excess_count: 7 }],
    [{ excess_count: 8 }],
    [{ excess_count: 9 }],
    [{ excess_count: 10 }],
    [{ excess_count: 11 }],
    [{ excess_count: 12 }],
    [{ anomaly_count: 13 }],
    [{ direct_count: 14 }],
    [{ active_owner_count: 1, owner_node_id: identities[2].legacyNodeId }],
  ];
}

type ExecuteOptions = { sql: string; values: unknown[]; timeout: number };

function finalEvidenceMysql(options: {
  rows?: Array<Array<Record<string, unknown>>>;
  failAtCall?: number;
  failure?: Error & { code?: string };
  rollbackFailure?: Error;
  endFailure?: Error;
} = {}) {
  const calls: ExecuteOptions[] = [];
  const rows = structuredClone(options.rows ?? finalEvidenceResultRows());
  let endCount = 0;
  let readIndex = 0;
  const mysql = {
    async createConnection(connection: Record<string, unknown>) {
      assert.deepEqual(connection, finalEvidencePayload.connection);
      return {
        async execute(executeOptions: ExecuteOptions) {
          if (
            !executeOptions ||
            typeof executeOptions !== "object" ||
            Array.isArray(executeOptions) ||
            JSON.stringify(Object.keys(executeOptions).sort()) !==
              JSON.stringify(["sql", "timeout", "values"])
          ) throw new Error("options-object-only execute contract");
          calls.push(structuredClone(executeOptions));
          const callNumber = calls.length;
          const sql = executeOptions.sql.trim().replace(/\s+/g, " ");
          if (options.failAtCall === callNumber) throw options.failure ?? new Error("query failed");
          if (sql === "ROLLBACK") {
            if (options.rollbackFailure) throw options.rollbackFailure;
            return [[], []];
          }
          if (
            sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ" ||
            sql === "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY" ||
            sql === "COMMIT"
          ) return [[], []];
          const result = rows[readIndex];
          readIndex += 1;
          return [result, []];
        },
        async end() {
          endCount += 1;
          if (options.endFailure) throw options.endFailure;
        },
      };
    },
  };
  return { calls, mysql, get endCount() { return endCount; } };
}

function controlEvidenceRow(
  actionId: Exclude<MeasurementActionId, "phase3-legacy-lease-release">,
  teamId: 1 | 2,
  epoch: string,
  generation: unknown = 7,
): Record<string, unknown> {
  const fenced = actionId !== "phase3-publication-enable";
  const acknowledged = actionId === "phase3-drain-or-quarantine"
    || actionId === "phase3-inline-owner-restore";
  return {
    team_id: teamId,
    cutover_epoch: epoch,
    publication_generation: generation,
    state: fenced ? "fenced" : "enabled",
    poller_node_id: identities[teamId].pollerNodeId,
    fence_job_id: fenced ? 10 : null,
    ack_node_id: acknowledged ? identities[teamId].pollerNodeId : null,
    ack_job_id: acknowledged ? 11 : null,
    acknowledged_at: acknowledged
      ? actionId === "phase3-drain-or-quarantine"
        ? new Date("2026-07-12T10:30:00.000Z")
        : "2026-07-12T10:30:00.000Z"
      : null,
    is_active: 1,
    active_epoch: epoch,
    active_generation: generation,
  };
}

const zeroDrainRow = {
  queued: 0,
  live_claims: 0,
  indeterminate: 0,
  unknown_count: 0,
  settlement_pending: 0,
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const expectedControlSql = normalizeSql(`
  SELECT team_id, cutover_epoch, publication_generation, state,
         poller_node_id, fence_job_id, ack_node_id, ack_job_id,
         acknowledged_at, is_active, active_epoch, active_generation
  FROM operational_phase3_control_evidence
  WHERE team_id = ? AND cutover_epoch = ?
`);
const expectedDrainSql = normalizeSql(`
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
`);
const expectedLeaseSql = normalizeSql(`
  SELECT owner_node_id, status,
         lease_expires_at > CURRENT_TIMESTAMP AS lease_active
  FROM team_runtime_leases
  WHERE team_id = ?
`);

interface MeasurementFixtureOptions {
  controlRows?: Array<Record<string, unknown>>;
  drainRows?: Array<Record<string, unknown>>;
  leaseRows?: Array<Record<string, unknown>>;
  failAfterLeaseRead?: boolean;
}

function measurementFixture(
  input: ReturnType<typeof measurementPayload>,
  options: MeasurementFixtureOptions = {},
) {
  const state = {
    calls: [] as Array<{ sql: string; parameters: unknown[] }>,
    createCount: 0,
    endCount: 0,
    leaseReads: 0,
  };
  const actionId = input.actionId;
  const defaultControlRows = actionId === "phase3-legacy-lease-release"
    ? []
    : [controlEvidenceRow(actionId, input.teamId, input.epoch)];
  const defaultLeaseRows = actionId === "phase3-inline-owner-restore"
    ? [{
        owner_node_id: identities[input.teamId].legacyNodeId,
        status: "running",
        lease_active: 1,
      }]
    : [];
  const mysql = {
    async createConnection(connectionConfig: unknown) {
      state.createCount += 1;
      assert.deepEqual(connectionConfig, input.connection);
      return {
        async execute(sql: string, parameters: unknown[]) {
          state.calls.push({ sql, parameters });
          if (/FROM operational_phase3_control_evidence/.test(sql)) {
            return [options.controlRows ?? defaultControlRows, []];
          }
          if (/FROM operational_phase3_evidence/.test(sql)) {
            return [options.drainRows ?? [zeroDrainRow], []];
          }
          if (/FROM team_runtime_leases/.test(sql)) {
            state.leaseReads += 1;
            if (options.failAfterLeaseRead && state.leaseReads > 1) {
              throw new Error("lease remained live sentinel");
            }
            return [options.leaseRows ?? defaultLeaseRows, []];
          }
          throw new Error(`unexpected measurement SQL: ${sql}`);
        },
        async end() {
          state.endCount += 1;
        },
      };
    },
  };
  return { mysql, state };
}

function expectedControlMeasurement(
  actionId: Exclude<MeasurementActionId, "phase3-legacy-lease-release">,
  teamId: 1 | 2,
  epoch: string,
) {
  const enabled = actionId === "phase3-publication-enable";
  const acknowledged = actionId === "phase3-drain-or-quarantine"
    || actionId === "phase3-inline-owner-restore";
  return {
    state: enabled ? "enabled" : "fenced",
    pollerNodeId: identities[teamId].pollerNodeId,
    isActive: true,
    activeEpoch: epoch,
    activeGeneration: 7,
    publicationGeneration: 7,
    fenceJobId: enabled ? null : 10,
    ackNodeId: acknowledged ? identities[teamId].pollerNodeId : null,
    ackJobId: acknowledged ? 11 : null,
    acknowledgedAt: acknowledged ? "2026-07-12T10:30:00.000Z" : null,
  };
}

async function captureRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected operation to reject");
}

async function main(): Promise<void> {
  assert.equal(
    typeof validateStagingPhase3ActionMeasurementPayload,
    "function",
    "validateStagingPhase3ActionMeasurementPayload export is required",
  );
  assert.equal(
    typeof executeStagingPhase3ActionMeasurementPayload,
    "function",
    "executeStagingPhase3ActionMeasurementPayload export is required",
  );
  assert.equal(
    typeof validateStagingPhase3EvidencePayload,
    "function",
    "validateStagingPhase3EvidencePayload export is required",
  );
  assert.equal(
    typeof executeStagingPhase3EvidencePayload,
    "function",
    "executeStagingPhase3EvidencePayload export is required",
  );
  assert.deepEqual(validateStagingPhase3EvidencePayload(finalEvidencePayload), finalEvidencePayload);
  for (const invalid of [
    { ...finalEvidencePayload, evidenceId: "other-evidence" },
    { ...finalEvidencePayload, teamId: 3 },
    { ...finalEvidencePayload, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...finalEvidencePayload, pollerNodeId: "stg-poller-ptwl-phase3-1" },
    { ...finalEvidencePayload, expectedOwnerNodeId: "stg-worker-ptwl-split-1" },
    { ...finalEvidencePayload, windowStartedAt: "2026-07-12 09:59:59" },
    { ...finalEvidencePayload, windowEndedAt: finalEvidencePayload.windowStartedAt },
    {
      ...finalEvidencePayload,
      windowStartedAt: finalEvidencePayload.windowEndedAt,
      windowEndedAt: finalEvidencePayload.windowStartedAt,
    },
    {
      ...finalEvidencePayload,
      connection: { ...finalEvidencePayload.connection, user: "root" },
    },
    {
      ...finalEvidencePayload,
      connection: {
        ...finalEvidencePayload.connection,
        ssl: { ...finalEvidencePayload.connection.ssl, rejectUnauthorized: false },
      },
    },
    { ...finalEvidencePayload, timeout: 1 },
  ]) {
    assert.throws(
      () => validateStagingPhase3EvidencePayload(invalid),
      /evidence|payload|partition|generation|timestamp|window|connection|actor|field/i,
    );
  }
  const finalPayloadWithSymbol = structuredClone(finalEvidencePayload) as Record<PropertyKey, unknown>;
  finalPayloadWithSymbol[Symbol("sql")] = "SELECT secret";
  assert.throws(
    () => validateStagingPhase3EvidencePayload(finalPayloadWithSymbol),
    /evidence|payload|field|symbol/i,
  );
  const hiddenFinalOverride = structuredClone(finalEvidencePayload) as Record<string, unknown>;
  Object.defineProperty(hiddenFinalOverride, "sql", {
    configurable: true,
    enumerable: false,
    value: "SELECT hidden_override",
  });
  assert.throws(
    () => validateStagingPhase3EvidencePayload(hiddenFinalOverride),
    /evidence|payload|field|own|data/i,
  );
  const hiddenKnownFinalField = structuredClone(finalEvidencePayload) as Record<string, unknown>;
  const hiddenWindowStart = hiddenKnownFinalField.windowStartedAt;
  delete hiddenKnownFinalField.windowStartedAt;
  Object.defineProperty(hiddenKnownFinalField, "windowStartedAt", {
    configurable: true,
    enumerable: false,
    value: hiddenWindowStart,
  });
  assert.throws(
    () => validateStagingPhase3EvidencePayload(hiddenKnownFinalField),
    /evidence|payload|field|own|data/i,
  );
  const accessorFinalPayload = structuredClone(finalEvidencePayload) as Record<string, unknown>;
  let discriminatorReads = 0;
  Object.defineProperty(accessorFinalPayload, "evidenceId", {
    configurable: true,
    enumerable: true,
    get() {
      discriminatorReads += 1;
      return discriminatorReads === 1 ? "phase3-gate4-final" : "changed-evidence";
    },
  });
  assert.throws(
    () => validateStagingPhase3EvidencePayload(accessorFinalPayload),
    /evidence|payload|field|own|data/i,
  );
  assert.equal(discriminatorReads, 0, "shape validation must not invoke accessors");
  const accessorConnectionPayload = structuredClone(finalEvidencePayload);
  Object.defineProperty(accessorConnectionPayload.connection, "password", {
    configurable: true,
    enumerable: true,
    get() { return "x".repeat(40); },
  });
  assert.throws(
    () => validateStagingPhase3EvidencePayload(accessorConnectionPayload),
    /connection|actor|field|own|data/i,
  );
  class FinalEvidenceRecord {
    constructor() { Object.assign(this, structuredClone(finalEvidencePayload)); }
  }
  assert.throws(
    () => validateStagingPhase3EvidencePayload(new FinalEvidenceRecord()),
    /evidence|payload|plain|object/i,
  );
  const inheritedFinalOverride = Object.assign(
    Object.create({ sql: "SELECT inherited_override" }),
    structuredClone(finalEvidencePayload),
  );
  assert.throws(
    () => validateStagingPhase3EvidencePayload(inheritedFinalOverride),
    /evidence|payload|plain|object/i,
  );
  const frozenFinalPayload = structuredClone(finalEvidencePayload);
  Object.freeze(frozenFinalPayload.connection.ssl);
  Object.freeze(frozenFinalPayload.connection);
  Object.freeze(frozenFinalPayload);
  assert.deepEqual(validateStagingPhase3EvidencePayload(frozenFinalPayload), frozenFinalPayload);
  let hiddenOverrideConnected = false;
  await assert.rejects(
    () => executeStagingPhase3EvidencePayload(hiddenFinalOverride, {
      async createConnection() {
        hiddenOverrideConnected = true;
        throw new Error("unexpected connection");
      },
    }),
    /evidence|payload|field|own|data/i,
  );
  assert.equal(hiddenOverrideConnected, false);

  const finalFixture = finalEvidenceMysql();
  const finalResult = await executeStagingPhase3EvidencePayload(
    finalEvidencePayload,
    finalFixture.mysql,
  );
  assert.deepEqual(finalResult, {
    ok: true,
    evidenceId: "phase3-gate4-final",
    control: {
      state: "fenced",
      generation: 7,
      fenceJobId: 40,
      ackJobId: 41,
      pollerNodeMatches: true,
      acknowledgedAt: "2026-07-12T10:00:05.000Z",
    },
    drain: {
      queued: 1,
      liveClaims: 2,
      indeterminate: 3,
      unknown: 4,
      settlementPending: 5,
    },
    duplicates: {
      externalAttempts: 6,
      results: 7,
      history: 8,
      bookingHistory: 9,
      notifications: 10,
      budgetReservations: 11,
      settlements: 12,
    },
    staleEpochActions: 13,
    directPollerAccepts: 14,
    inlineLease: {
      activeOwnerCount: 1,
      ownerNodeId: identities[2].legacyNodeId,
      ownerMatches: true,
    },
  });
  assert.equal(Object.isFrozen(finalResult), true);
  assert.equal(Object.isFrozen(finalResult.duplicates), true);
  assert.equal(JSON.stringify(finalResult).includes(observerConnection.password), false);
  assert.equal(finalFixture.endCount, 1);
  assert.equal(finalFixture.calls.length, 15);
  assert.deepEqual(
    finalFixture.calls.map(({ timeout, values }) => ({ timeout, valuesIsArray: Array.isArray(values) })),
    Array.from({ length: 15 }, () => ({ timeout: 5_000, valuesIsArray: true })),
  );
  const normalizedFinalSql = finalFixture.calls.map(({ sql }) => sql.trim().replace(/\s+/g, " "));
  assert.equal(normalizedFinalSql[0], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  assert.equal(normalizedFinalSql[1], "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  assert.equal(normalizedFinalSql.at(-1), "COMMIT");
  const finalReadSql = normalizedFinalSql.slice(2, 14);
  assert.match(finalReadSql[0], /FROM operational_phase3_control_evidence/i);
  assert.match(finalReadSql[1], /FROM operational_phase3_evidence/i);
  assert.match(finalReadSql[2], /auto_accept_attempts/i);
  assert.match(finalReadSql[3], /auto_accept_results/i);
  assert.match(finalReadSql[4], /auto_accept_history/i);
  assert.match(finalReadSql[5], /spx_booking_history/i);
  assert.match(finalReadSql[6], /notification_events/i);
  assert.match(finalReadSql[7], /settlement_step = 'budget_reservation'/i);
  assert.match(finalReadSql[8], /GROUP BY j\.id, s\.settlement_step/i);
  assert.match(finalReadSql[9], /FROM auto_accept_jobs/i);
  assert.match(finalReadSql[10], /FROM auto_accept_attempts/i);
  assert.match(finalReadSql[11], /FROM team_runtime_leases/i);
  for (const sql of finalReadSql.slice(0, 9)) {
    assert.match(sql, /team_id = \?/i);
    assert.match(sql, /cutover_epoch = \?/i);
    assert.match(sql, /publication_generation = \?/i);
  }
  for (const call of finalFixture.calls.slice(2, 11)) {
    assert.deepEqual(call.values, [
      finalEvidencePayload.teamId,
      finalEvidencePayload.epoch,
      finalEvidencePayload.generation,
    ]);
  }
  assert.match(finalReadSql[2], /REGEXP_LIKE\([\s\S]*'c'\s*\)/i);
  assert.match(finalReadSql[2], /CONCAT\('\^aa-job:', CAST\(j\.id AS CHAR\), ':external:\[1-9\]\[0-9\]\*\$'\)/i);
  assert.match(finalReadSql[2], /GROUP BY j\.id/i);
  assert.doesNotMatch(finalReadSql[2], /GROUP BY[^)]*(?:a\.)?trace_id/i);
  assert.match(finalReadSql[9], /created_at >= \? AND j\.created_at <= \?/i);
  assert.match(finalReadSql[9], /cutover_epoch IS NOT NULL/i);
  assert.match(finalReadSql[9], /publication_generation IS NOT NULL/i);
  assert.match(finalReadSql[9], /cutover_epoch <> \? OR j\.publication_generation <> \?/i);
  for (const predicate of [
    /status IN \('pending', 'retrying', 'claimed', 'verifying'\)/i,
    /winning_attempt_trace_id IS NOT NULL/i,
    /result_status IS NOT NULL/i,
    /completed_at IS NOT NULL/i,
  ]) assert.match(finalReadSql[9], predicate);
  assert.deepEqual(finalFixture.calls[11].values, [
    finalEvidencePayload.teamId,
    "2026-07-12 09:59:59",
    "2026-07-12 10:00:07",
    finalEvidencePayload.epoch,
    finalEvidencePayload.generation,
  ]);
  assert.match(finalReadSql[10], /a\.team_id = \?/i);
  assert.match(finalReadSql[10], /a\.worker_node_id = \?/i);
  assert.match(finalReadSql[10], /a\.created_at >= \?/i);
  assert.doesNotMatch(finalReadSql[10], /created_at <=|accept_finished_at|ambiguous_accept/i);
  assert.deepEqual(finalFixture.calls[12].values, [
    finalEvidencePayload.teamId,
    finalEvidencePayload.pollerNodeId,
    "2026-07-12 09:59:59",
  ]);
  assert.deepEqual(finalFixture.calls[13].values, [finalEvidencePayload.teamId]);
  assert.equal(
    finalReadSql.some((sql) => sql.includes(finalEvidencePayload.epoch)),
    false,
    "query values must never be interpolated into fixed SQL",
  );

  const rejectRows = async (
    mutate: (rows: Array<Array<Record<string, unknown>>>) => void,
    pattern = /invalid|control|drain|count|lease|owner/i,
  ) => {
    const rows = finalEvidenceResultRows();
    mutate(rows);
    const fixture = finalEvidenceMysql({ rows });
    await assert.rejects(
      () => executeStagingPhase3EvidencePayload(finalEvidencePayload, fixture.mysql),
      pattern,
    );
    assert.equal(fixture.endCount, 1);
    assert.equal(fixture.calls.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(fixture.calls.some(({ sql }) => sql.trim() === "COMMIT"), false);
  };
  for (const [field, invalid] of [
    ["queued", -1],
    ["live_claims", 1.5],
    ["indeterminate", Number.MAX_SAFE_INTEGER + 1],
    ["unknown_count", null],
    ["settlement_pending", "01"],
  ] as const) {
    await rejectRows((rows) => { rows[1][0][field] = invalid; });
  }
  for (let index = 2; index <= 10; index += 1) {
    const field = index <= 8 ? "excess_count" : index === 9 ? "anomaly_count" : "direct_count";
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await rejectRows((rows) => { rows[index][0][field] = invalid; });
    }
  }
  await rejectRows((rows) => { rows[0][0].state = "enabled"; }, /control|fenced/i);
  await rejectRows((rows) => { rows[0][0].ack_job_id = 39; }, /control|ack|fence/i);
  await rejectRows((rows) => { rows[0][0].poller_node_id = "wrong-poller"; }, /control|poller/i);
  await rejectRows((rows) => { rows[0][0].extra = "raw-row"; }, /control|row|field/i);
  await rejectRows((rows) => { delete rows[1][0].queued; }, /drain|row|field/i);
  await rejectRows((rows) => { rows[11][0].active_owner_count = 0; }, /lease|owner/i);
  await rejectRows((rows) => { rows[11][0].active_owner_count = 2; }, /lease|owner/i);
  await rejectRows(
    (rows) => { rows[11][0].active_owner_count = Number.MAX_SAFE_INTEGER + 1; },
    /lease|owner|count/i,
  );
  await rejectRows((rows) => { rows[11][0].owner_node_id = "wrong-owner"; }, /lease|owner/i);
  const finalRowFields = [
    "state",
    "queued",
    "excess_count",
    "excess_count",
    "excess_count",
    "excess_count",
    "excess_count",
    "excess_count",
    "excess_count",
    "anomaly_count",
    "direct_count",
    "active_owner_count",
  ];
  for (const [index, field] of finalRowFields.entries()) {
    await rejectRows((rows) => { delete rows[index][0][field]; }, /invalid|row|field|count|control|drain|lease/i);
    await rejectRows((rows) => { rows[index][0].raw_secret = "raw-row-sentinel"; }, /invalid|row|field|count|control|drain|lease/i);
  }

  const primaryFailure = new Error("primary-query-sentinel");
  const primaryFixture = finalEvidenceMysql({
    failAtCall: 5,
    failure: primaryFailure,
    rollbackFailure: new Error("rollback-cleanup-sentinel"),
    endFailure: new Error("end-cleanup-sentinel"),
  });
  let caughtPrimary: unknown;
  try {
    await executeStagingPhase3EvidencePayload(finalEvidencePayload, primaryFixture.mysql);
  } catch (error) {
    caughtPrimary = error;
  }
  assert.equal(caughtPrimary, primaryFailure);
  assert.equal(primaryFixture.calls.at(-1)?.sql.trim(), "ROLLBACK");
  assert.equal(primaryFixture.endCount, 1);

  const timeoutFailure = Object.assign(new Error("timeout-sentinel"), { code: "ETIMEDOUT" });
  const timeoutFixture = finalEvidenceMysql({ failAtCall: 3, failure: timeoutFailure });
  let caughtTimeout: unknown;
  try {
    await executeStagingPhase3EvidencePayload(finalEvidencePayload, timeoutFixture.mysql);
  } catch (error) {
    caughtTimeout = error;
  }
  assert.equal(caughtTimeout, timeoutFailure);
  assert.equal(timeoutFixture.calls.at(-1)?.sql.trim(), "ROLLBACK");
  assert.equal(timeoutFixture.endCount, 1);

  const commitFailure = new Error("commit-sentinel");
  const commitFixture = finalEvidenceMysql({ failAtCall: 15, failure: commitFailure });
  let caughtCommit: unknown;
  try {
    await executeStagingPhase3EvidencePayload(finalEvidencePayload, commitFixture.mysql);
  } catch (error) {
    caughtCommit = error;
  }
  assert.equal(caughtCommit, commitFailure);
  assert.equal(commitFixture.calls.at(-1)?.sql.trim(), "ROLLBACK");
  assert.equal(commitFixture.endCount, 1);

  const endFailure = new Error("end-sentinel");
  const endFixture = finalEvidenceMysql({ endFailure });
  await assert.rejects(
    () => executeStagingPhase3EvidencePayload(finalEvidencePayload, endFixture.mysql),
    (error: unknown) => error === endFailure,
  );
  assert.equal(endFixture.calls.at(-1)?.sql.trim(), "COMMIT");
  assert.equal(endFixture.endCount, 1);

  const controllerSource = readFileSync("scripts/staging-phase3-db-controller.mjs", "utf8");
  assert.match(
    controllerSource,
    /Object\.hasOwn\(payload,\s*["']evidenceId["']\)[\s\S]*Object\.hasOwn\(payload,\s*["']observationId["']\)[\s\S]*Object\.hasOwn\(payload,\s*["']actionId["']\)/,
  );
  assert.doesNotMatch(controllerSource, /payload\?\.(?:evidenceId|observationId|actionId)\s*\?/);

  assert.deepEqual(validateStagingPhase3DatabasePayload(payload), payload);
  assert.throws(
    () => validateStagingPhase3DatabasePayload({ ...payload, teamId: 3 }),
    /team|partition/i,
  );
  assert.throws(
    () => validateStagingPhase3DatabasePayload({
      ...payload,
      connection: { ...payload.connection, user: "root" },
    }),
    /connection|actor/i,
  );
  assert.throws(
    () => validateStagingPhase3DatabasePayload({ ...payload, sql: "DROP DATABASE spx" }),
    /field|payload/i,
  );
  assert.throws(
    () => validateStagingPhase3DatabasePayload({ ...payload, action: "fence-ack-wait" }),
    /action|payload/i,
  );

  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const control = {
    state: "fenced",
    poller_node_id: payload.pollerNodeId,
    publication_generation: 7,
    fence_job_id: 10,
    ack_node_id: payload.pollerNodeId,
    ack_job_id: 10,
    acknowledged_at: "2026-07-11T00:00:00.000Z",
  };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters });
      if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
        return [[{ active_epoch: payload.epoch, active_generation: 7 }], []];
      }
      if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
      if (/FROM auto_accept_jobs/.test(sql)) {
        return [[{ active_count: 0, unknown_count: 0, settlement_pending: 0 }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async end() {},
  };
  const mysql = { async createConnection() { return connection; } };
  assert.deepEqual(
    await executeStagingPhase3DatabasePayload(
      { ...payload, action: "drain-or-quarantine", expectedGeneration: 7 },
      mysql,
    ),
    { ok: true, action: "drain-or-quarantine" },
  );
  const drain = calls.find(({ sql }) => /FROM auto_accept_jobs/.test(sql));
  assert.ok(drain);
  assert.match(drain.sql, /publication_generation\s*=\s*\?/);
  assert.deepEqual(drain.parameters, [payload.teamId, payload.epoch, 7]);
  assert.equal(
    normalizeSql(drain.sql).match(/COALESCE\(SUM\(/g)?.length,
    3,
    "signed mutation drain must make all three empty-set aggregates explicit",
  );

  const mutationDrainFixture = (drainRows: Array<Record<string, unknown>>) => {
    const state = { endCount: 0 };
    return {
      state,
      mysql: {
        async createConnection() {
          return {
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            async execute(sql: string) {
              if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
                return [[{ active_epoch: payload.epoch, active_generation: 7 }], []];
              }
              if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
              if (/FROM auto_accept_jobs/.test(sql)) return [drainRows, []];
              throw new Error(`unexpected mutation drain SQL: ${sql}`);
            },
            async end() {
              state.endCount += 1;
            },
          };
        },
      },
    };
  };
  const stringZeroDrain = mutationDrainFixture([{
    active_count: "0",
    unknown_count: "0",
    settlement_pending: "0",
  }]);
  assert.deepEqual(
    await executeStagingPhase3DatabasePayload(
      { ...payload, action: "drain-or-quarantine", expectedGeneration: 7 },
      stringZeroDrain.mysql,
    ),
    { ok: true, action: "drain-or-quarantine" },
  );
  assert.equal(stringZeroDrain.state.endCount, 1);
  for (const invalidRows of [
    [],
    [
      { active_count: 0, unknown_count: 0, settlement_pending: 0 },
      { active_count: 0, unknown_count: 0, settlement_pending: 0 },
    ],
    [{ active_count: null, unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: false, unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: "", unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: "00", unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: -1, unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: 0.5, unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: Number.MAX_SAFE_INTEGER + 1, unknown_count: 0, settlement_pending: 0 }],
    [{ active_count: 0, unknown_count: null, settlement_pending: 0 }],
    [{ active_count: 0, unknown_count: 0, settlement_pending: null }],
  ] as Array<Array<Record<string, unknown>>>) {
    const fixture = mutationDrainFixture(invalidRows);
    await assert.rejects(
      () => executeStagingPhase3DatabasePayload(
        { ...payload, action: "drain-or-quarantine", expectedGeneration: 7 },
        fixture.mysql,
      ),
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const restoreCalls: Array<{ sql: string; parameters: unknown[] }> = [];
  const restoreMysql = {
    async createConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async execute(sql: string, parameters: unknown[]) {
          restoreCalls.push({ sql, parameters });
          if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
            return [[{ active_epoch: payload.epoch, active_generation: 7 }], []];
          }
          if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
          if (/FROM auto_accept_jobs/.test(sql)) {
            return [[{ active_count: 0, unknown_count: 0, settlement_pending: 0 }], []];
          }
          if (/FROM team_runtime_leases/.test(sql)) {
            return [[{
              owner_node_id: payload.expectedOwnerNodeId,
              status: "running",
              lease_active: 1,
            }], []];
          }
          throw new Error(`unexpected restore SQL: ${sql}`);
        },
        async end() {},
      };
    },
  };
  assert.deepEqual(
    await executeStagingPhase3DatabasePayload(
      { ...payload, action: "inline-owner-restore", expectedGeneration: 7 },
      restoreMysql,
    ),
    { ok: true, action: "inline-owner-restore" },
  );
  assert.equal(
    restoreCalls.filter(({ sql }) => /FROM auto_accept_publication_controls/.test(sql)).length,
    2,
  );
  assert.equal(
    restoreCalls.filter(({ sql }) => /FROM auto_accept_jobs/.test(sql)).length,
    2,
  );
  assert.equal(
    restoreCalls.filter(({ sql, parameters }) =>
      /FROM auto_accept_jobs/.test(sql) &&
      JSON.stringify(parameters) === JSON.stringify([payload.teamId, payload.epoch, 7])).length,
    2,
  );
  const precheckCalls: string[] = [];
  const precheckMysql = {
    async createConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async execute(sql: string) {
          precheckCalls.push(sql);
          if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
            return [[{ active_epoch: payload.epoch, active_generation: 7 }], []];
          }
          if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
          if (/FROM auto_accept_jobs/.test(sql)) {
            return [[{ active_count: 0, unknown_count: 0, settlement_pending: 0 }], []];
          }
          throw new Error(`unexpected precheck SQL: ${sql}`);
        },
        async end() {},
      };
    },
  };
  assert.deepEqual(
    await executeStagingPhase3DatabasePayload(
      { ...payload, action: "inline-owner-restore-precheck", expectedGeneration: 7 },
      precheckMysql,
    ),
    { ok: true, action: "inline-owner-restore-precheck" },
  );
  assert.equal(precheckCalls.some((sql) => /team_runtime_leases/.test(sql)), false);

  let activeRead = 0;
  await assert.rejects(
    () => executeStagingPhase3DatabasePayload(
      { ...payload, action: "inline-owner-restore", expectedGeneration: 7 },
      {
        async createConnection() {
          return {
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            async execute(sql: string) {
              if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
                activeRead += 1;
                return [[{
                  active_epoch: payload.epoch,
                  active_generation: activeRead === 1 ? 7 : 8,
                }], []];
              }
              if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
              if (/FROM auto_accept_jobs/.test(sql)) {
                return [[{ active_count: 0, unknown_count: 0, settlement_pending: 0 }], []];
              }
              if (/FROM team_runtime_leases/.test(sql)) {
                return [[{
                  owner_node_id: payload.expectedOwnerNodeId,
                  status: "running",
                  lease_active: 1,
                }], []];
              }
              throw new Error(`unexpected changed-pointer SQL: ${sql}`);
            },
            async end() {},
          };
        },
      },
    ),
    /generation|pointer|identity|changed/i,
  );

  const mutationLeaseFixture = (
    leaseRows: Array<Record<string, unknown>>,
    failAfterFirstLeaseRead = false,
  ) => {
    const state = { endCount: 0, leaseReads: 0 };
    return {
      state,
      mysql: {
        async createConnection() {
          return {
            async execute(sql: string) {
              assert.match(sql, /FROM team_runtime_leases/);
              state.leaseReads += 1;
              if (failAfterFirstLeaseRead && state.leaseReads > 1) {
                throw new Error("lease remained live sentinel");
              }
              return [leaseRows, []];
            },
            async end() {
              state.endCount += 1;
            },
          };
        },
      },
    };
  };
  for (const leaseRows of [
    [],
    [{ owner_node_id: "expired-owner", status: "running", lease_active: 0 }],
  ] as Array<Array<Record<string, unknown>>>) {
    const fixture = mutationLeaseFixture(leaseRows);
    assert.deepEqual(
      await executeStagingPhase3DatabasePayload(
        { ...payload, action: "legacy-lease-release" },
        fixture.mysql,
      ),
      { ok: true, action: "legacy-lease-release" },
    );
    assert.equal(fixture.state.leaseReads, 1);
    assert.equal(fixture.state.endCount, 1);
  }
  for (const ownerNodeId of [payload.expectedOwnerNodeId, "different-live-owner"]) {
    const fixture = mutationLeaseFixture([{
      owner_node_id: ownerNodeId,
      status: "running",
      lease_active: 1,
    }], true);
    await assert.rejects(
      () => executeStagingPhase3DatabasePayload(
        { ...payload, action: "legacy-lease-release" },
        fixture.mysql,
      ),
      /lease remained live sentinel/,
    );
    assert.equal(fixture.state.leaseReads, 2);
    assert.equal(fixture.state.endCount, 1);
  }
  for (const leaseRows of [
    [
      { owner_node_id: payload.expectedOwnerNodeId, status: "running", lease_active: 1 },
      { owner_node_id: "duplicate", status: "running", lease_active: 1 },
    ],
    [{ owner_node_id: payload.expectedOwnerNodeId, status: "active", lease_active: 1 }],
    [{ owner_node_id: payload.expectedOwnerNodeId, status: "running", lease_active: true }],
  ] as Array<Array<Record<string, unknown>>>) {
    const fixture = mutationLeaseFixture(leaseRows, true);
    await assert.rejects(
      () => executeStagingPhase3DatabasePayload(
        { ...payload, action: "legacy-lease-release" },
        fixture.mysql,
      ),
      /lease|row|status|active|invalid/i,
    );
    assert.equal(fixture.state.leaseReads, 1, "malformed lease state must fail immediately");
    assert.equal(fixture.state.endCount, 1);
  }

  const mutationRestoreFixture = (
    leaseRows: Array<Record<string, unknown>>,
    failAfterFirstLeaseRead = false,
  ) => {
    const state = { endCount: 0, leaseReads: 0 };
    return {
      state,
      mysql: {
        async createConnection() {
          return {
            async beginTransaction() {},
            async commit() {},
            async rollback() {},
            async execute(sql: string) {
              if (/FROM auto_accept_publication_active_epochs/.test(sql)) {
                return [[{ active_epoch: payload.epoch, active_generation: 7 }], []];
              }
              if (/FROM auto_accept_publication_controls/.test(sql)) return [[control], []];
              if (/FROM auto_accept_jobs/.test(sql)) {
                return [[{ active_count: 0, unknown_count: 0, settlement_pending: 0 }], []];
              }
              if (/FROM team_runtime_leases/.test(sql)) {
                state.leaseReads += 1;
                if (failAfterFirstLeaseRead && state.leaseReads > 1) {
                  throw new Error("inline lease remained absent sentinel");
                }
                return [leaseRows, []];
              }
              throw new Error(`unexpected mutation restore SQL: ${sql}`);
            },
            async end() {
              state.endCount += 1;
            },
          };
        },
      },
    };
  };
  for (const leaseRows of [
    [],
    [{ owner_node_id: payload.expectedOwnerNodeId, status: "running", lease_active: 0 }],
  ] as Array<Array<Record<string, unknown>>>) {
    const fixture = mutationRestoreFixture(leaseRows, true);
    await assert.rejects(
      () => executeStagingPhase3DatabasePayload(
        { ...payload, action: "inline-owner-restore", expectedGeneration: 7 },
        fixture.mysql,
      ),
      /inline lease remained absent sentinel/,
    );
    assert.equal(fixture.state.leaseReads, 2);
    assert.equal(fixture.state.endCount, 1);
  }
  const duplicateRestore = mutationRestoreFixture([
    { owner_node_id: payload.expectedOwnerNodeId, status: "running", lease_active: 1 },
    { owner_node_id: payload.expectedOwnerNodeId, status: "running", lease_active: 1 },
  ], true);
  await assert.rejects(
    () => executeStagingPhase3DatabasePayload(
      { ...payload, action: "inline-owner-restore", expectedGeneration: 7 },
      duplicateRestore.mysql,
    ),
    /lease|row|invalid/i,
  );
  assert.equal(duplicateRestore.state.leaseReads, 1);
  assert.equal(duplicateRestore.state.endCount, 1);

  for (const actionId of measurementActionIds) {
    const input = measurementPayload(actionId);
    const originalConnection = structuredClone(input.connection);
    const validated = validateStagingPhase3ActionMeasurementPayload(input);
    assert.equal(validated, input, `${actionId} validator must return the original payload`);
    assert.equal(validated.connection, input.connection);
    assert.deepEqual(input.connection, originalConnection);
    assert.equal(validated.expectedGeneration, expectedGenerationByAction[actionId]);
  }
  const maximumEpoch = `e${"x".repeat(79)}`;
  assert.equal(
    validateStagingPhase3ActionMeasurementPayload(
      measurementPayload("phase3-publication-enable", 1, maximumEpoch),
    ).epoch,
    maximumEpoch,
  );

  const invalidMeasurementPayloads: unknown[] = [
    { ...measurementPayload("phase3-publication-enable"), expectedGeneration: 1 },
    { ...measurementPayload("phase3-publication-fence"), expectedGeneration: 7 },
    { ...measurementPayload("phase3-legacy-lease-release"), expectedGeneration: 0 },
    { ...measurementPayload("phase3-drain-or-quarantine"), expectedGeneration: null },
    { ...measurementPayload("phase3-inline-owner-restore"), expectedGeneration: 0 },
    { ...measurementPayload("phase3-inline-owner-restore"), expectedGeneration: 1.5 },
    { ...measurementPayload("phase3-inline-owner-restore"), expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...measurementPayload("phase3-publication-enable"), pollerNodeId: identities[2].pollerNodeId },
    { ...measurementPayload("phase3-publication-enable"), expectedOwnerNodeId: identities[2].legacyNodeId },
    { ...measurementPayload("phase3-publication-enable"), sql: "SELECT secret" },
    { ...measurementPayload("phase3-publication-enable"), query: "caller query" },
    { ...measurementPayload("phase3-publication-enable"), service: "poller-ifn-phase3" },
    { ...measurementPayload("phase3-publication-enable"), path: "C:/tmp/result" },
    { ...measurementPayload("phase3-publication-enable"), url: "https://example.invalid" },
    { ...measurementPayload("phase3-publication-enable"), command: "docker ps" },
    { ...measurementPayload("phase3-publication-enable"), result: {} },
    { ...measurementPayload("phase3-publication-enable"), actionId: "phase3-poller-start" },
    { ...measurementPayload("phase3-publication-enable"), actionId: "phase3-consumer-start-disabled" },
    { ...measurementPayload("phase3-publication-enable"), actionId: "phase3-execution-enable" },
    { ...measurementPayload("phase3-publication-enable"), actionId: "unknown-action" },
    { ...measurementPayload("phase3-publication-enable"), teamId: 3 },
    { ...measurementPayload("phase3-publication-enable"), epoch: "" },
    { ...measurementPayload("phase3-publication-enable"), epoch: "../epoch" },
    { ...measurementPayload("phase3-publication-enable"), epoch: `e${"x".repeat(80)}` },
    {
      ...measurementPayload("phase3-publication-enable"),
      connection: { ...observerConnection, user: "spx_stg_phase3_control" },
    },
    {
      ...measurementPayload("phase3-publication-enable"),
      connection: { ...observerConnection, user: "root" },
    },
    {
      ...measurementPayload("phase3-publication-enable"),
      connection: { host: observerConnection.host },
    },
  ];
  for (const invalid of invalidMeasurementPayloads) {
    assert.throws(() => validateStagingPhase3ActionMeasurementPayload(invalid));
    let createCount = 0;
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(invalid, {
        async createConnection() {
          createCount += 1;
          throw new Error("invalid payload reached database");
        },
      }),
    );
    assert.equal(createCount, 0, "invalid measurement payload must fail before connection creation");
  }

  for (const [actionId, teamId] of [
    ["phase3-legacy-lease-release", 1],
    ["phase3-publication-enable", 2],
    ["phase3-publication-fence", 1],
    ["phase3-drain-or-quarantine", 2],
    ["phase3-inline-owner-restore", 1],
  ] as const) {
    const input = measurementPayload(actionId, teamId);
    const fixture = measurementFixture(input);
    const result = await executeStagingPhase3ActionMeasurementPayload(input, fixture.mysql);
    const control = actionId === "phase3-legacy-lease-release"
      ? undefined
      : expectedControlMeasurement(actionId, teamId, input.epoch);
    const expected = actionId === "phase3-legacy-lease-release"
      ? {
          ok: true,
          actionId,
          teamId,
          epoch: input.epoch,
          generation: null,
          measurements: {
            lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false },
          },
        }
      : actionId === "phase3-publication-enable" || actionId === "phase3-publication-fence"
        ? {
            ok: true,
            actionId,
            teamId,
            epoch: input.epoch,
            generation: 7,
            measurements: { control },
          }
        : actionId === "phase3-drain-or-quarantine"
          ? {
              ok: true,
              actionId,
              teamId,
              epoch: input.epoch,
              generation: 7,
              measurements: {
                control,
                drain: {
                  queued: 0,
                  liveClaims: 0,
                  indeterminate: 0,
                  unknown: 0,
                  settlementPending: 0,
                },
              },
            }
          : {
              ok: true,
              actionId,
              teamId,
              epoch: input.epoch,
              generation: 7,
              measurements: {
                control,
                drain: {
                  queued: 0,
                  liveClaims: 0,
                  indeterminate: 0,
                  unknown: 0,
                  settlementPending: 0,
                },
                lease: {
                  activeOwnerCount: 1,
                  ownerNodeId: identities[teamId].legacyNodeId,
                  status: "active",
                },
              },
            };
    assert.deepEqual(result, expected);
    assert.equal(fixture.state.createCount, 1);
    assert.equal(fixture.state.endCount, 1);
    const normalizedCalls = fixture.state.calls.map(({ sql, parameters }) => ({
      sql: normalizeSql(sql),
      parameters,
    }));
    const expectedCalls = actionId === "phase3-legacy-lease-release"
      ? [{ sql: expectedLeaseSql, parameters: [teamId] }]
      : actionId === "phase3-publication-enable" || actionId === "phase3-publication-fence"
        ? [{ sql: expectedControlSql, parameters: [teamId, input.epoch] }]
        : actionId === "phase3-drain-or-quarantine"
          ? [
              { sql: expectedControlSql, parameters: [teamId, input.epoch] },
              { sql: expectedDrainSql, parameters: [teamId, input.epoch, 7] },
            ]
          : [
              { sql: expectedControlSql, parameters: [teamId, input.epoch] },
              { sql: expectedDrainSql, parameters: [teamId, input.epoch, 7] },
              { sql: expectedLeaseSql, parameters: [teamId] },
            ];
    assert.deepEqual(normalizedCalls, expectedCalls, `${actionId} must execute only fixed SQL`);
    for (const call of normalizedCalls) {
      assert.doesNotMatch(
        call.sql,
        /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b|FOR\s+UPDATE/i,
      );
      assert.doesNotMatch(call.sql, /completed_at/i);
    }
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(input.connection.password), false);
    assert.equal(serialized.includes(input.connection.ssl.ca), false);
    assert.equal(serialized.includes("connection"), false);
    if (actionId === "phase3-inline-owner-restore") {
      assert.equal("services" in result.measurements, false);
    }
  }

  const drainInput = measurementPayload("phase3-drain-or-quarantine", 2);
  const validDrainControl = controlEvidenceRow(
    "phase3-drain-or-quarantine",
    drainInput.teamId,
    drainInput.epoch,
  );
  const invalidControlRows: Array<Array<Record<string, unknown>>> = [
    [],
    [validDrainControl, { ...validDrainControl }],
    [{ ...validDrainControl, team_id: 1 }],
    [{ ...validDrainControl, cutover_epoch: "changed-epoch" }],
    [{ ...validDrainControl, poller_node_id: identities[1].pollerNodeId }],
    [{ ...validDrainControl, state: "enabled" }],
    [{ ...validDrainControl, state: "disabled" }],
    [{ ...validDrainControl, active_epoch: "changed-epoch" }],
    [{ ...validDrainControl, active_generation: 8, publication_generation: 8 }],
    [{ ...validDrainControl, active_generation: 8 }],
    [{ ...validDrainControl, is_active: 0 }],
    [{ ...validDrainControl, fence_job_id: null }],
    [{ ...validDrainControl, ack_node_id: null }],
    [{ ...validDrainControl, ack_job_id: null }],
    [{ ...validDrainControl, acknowledged_at: null }],
    [{ ...validDrainControl, ack_node_id: identities[1].pollerNodeId }],
    [{ ...validDrainControl, ack_job_id: 9 }],
    [{ ...validDrainControl, acknowledged_at: "not-a-date" }],
  ];
  for (const controlRows of invalidControlRows) {
    const fixture = measurementFixture(drainInput, { controlRows });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(drainInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
    assert.equal(fixture.state.calls.length, 1, "invalid control must block later queries");
  }

  const enableInput = measurementPayload("phase3-publication-enable", 1);
  const enabledRow = controlEvidenceRow(
    "phase3-publication-enable",
    enableInput.teamId,
    enableInput.epoch,
  );
  for (const field of ["fence_job_id", "ack_node_id", "ack_job_id", "acknowledged_at"] as const) {
    const fixture = measurementFixture(enableInput, {
      controlRows: [{ ...enabledRow, [field]: field === "ack_node_id" ? identities[1].pollerNodeId : 1 }],
    });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(enableInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const fenceInput = measurementPayload("phase3-publication-fence", 2);
  const fencedRow = controlEvidenceRow(
    "phase3-publication-fence",
    fenceInput.teamId,
    fenceInput.epoch,
  );
  for (const partial of [
    { ack_node_id: identities[2].pollerNodeId },
    { ack_job_id: 11 },
    { acknowledged_at: "2026-07-12T10:30:00.000Z" },
  ]) {
    const fixture = measurementFixture(fenceInput, { controlRows: [{ ...fencedRow, ...partial }] });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(fenceInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const invalidIntegers: unknown[] = [
    null,
    undefined,
    false,
    true,
    "",
    " ",
    "01",
    "+1",
    "-1",
    "-0",
    -0,
    -1,
    1.5,
    "1.5",
    "1e0",
    "0x1",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    String(Number.MAX_SAFE_INTEGER + 1),
    [],
    {},
    1n,
    Buffer.from("1"),
  ];
  for (const field of [
    "publication_generation",
    "active_generation",
    "is_active",
    "fence_job_id",
    "ack_job_id",
  ] as const) {
    for (const invalid of invalidIntegers) {
      const fixture = measurementFixture(drainInput, {
        controlRows: [{ ...validDrainControl, [field]: invalid }],
      });
      await assert.rejects(
        () => executeStagingPhase3ActionMeasurementPayload(drainInput, fixture.mysql),
        undefined,
        `${field} accepted malformed integer ${String(invalid)}`,
      );
      assert.equal(fixture.state.endCount, 1);
    }
  }
  for (const field of [
    "queued",
    "live_claims",
    "indeterminate",
    "unknown_count",
    "settlement_pending",
  ] as const) {
    for (const invalid of invalidIntegers) {
      const fixture = measurementFixture(drainInput, {
        drainRows: [{ ...zeroDrainRow, [field]: invalid }],
      });
      await assert.rejects(
        () => executeStagingPhase3ActionMeasurementPayload(drainInput, fixture.mysql),
        undefined,
        `${field} accepted malformed integer ${String(invalid)}`,
      );
      assert.equal(fixture.state.endCount, 1);
    }
    const nonzeroFixture = measurementFixture(drainInput, {
      drainRows: [{ ...zeroDrainRow, [field]: 1 }],
    });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(drainInput, nonzeroFixture.mysql),
      /drain|postcondition|zero/i,
    );
  }
  for (const drainRows of [[], [zeroDrainRow, { ...zeroDrainRow }]]) {
    const fixture = measurementFixture(drainInput, { drainRows });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(drainInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const inlineInput = measurementPayload("phase3-inline-owner-restore", 1);
  for (const invalid of invalidIntegers) {
    const fixture = measurementFixture(inlineInput, {
      leaseRows: [{
        owner_node_id: identities[1].legacyNodeId,
        status: "running",
        lease_active: invalid,
      }],
    });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(inlineInput, fixture.mysql),
      undefined,
      `lease_active accepted malformed integer ${String(invalid)}`,
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const stringFixture = measurementFixture(inlineInput, {
    controlRows: [{
      ...controlEvidenceRow("phase3-inline-owner-restore", 1, inlineInput.epoch),
      publication_generation: "7",
      active_generation: "7",
      is_active: "1",
      fence_job_id: "10",
      ack_job_id: "11",
    }],
    drainRows: [{
      queued: "0",
      live_claims: "0",
      indeterminate: "0",
      unknown_count: "0",
      settlement_pending: "0",
    }],
    leaseRows: [{
      owner_node_id: identities[1].legacyNodeId,
      status: "running",
      lease_active: "1",
    }],
  });
  const stringResult = await executeStagingPhase3ActionMeasurementPayload(
    inlineInput,
    stringFixture.mysql,
  );
  assert.equal(stringResult.generation, 7);
  assert.equal(stringResult.measurements.control.activeGeneration, 7);
  assert.equal(stringResult.measurements.control.fenceJobId, 10);
  assert.equal(stringResult.measurements.control.ackJobId, 11);
  assert.deepEqual(stringResult.measurements.drain, {
    queued: 0,
    liveClaims: 0,
    indeterminate: 0,
    unknown: 0,
    settlementPending: 0,
  });

  const legacyInput = measurementPayload("phase3-legacy-lease-release", 2);
  const expiredResidual = measurementFixture(legacyInput, {
    leaseRows: [{ owner_node_id: "residual-owner", status: "stopped", lease_active: "0" }],
  });
  assert.deepEqual(
    await executeStagingPhase3ActionMeasurementPayload(legacyInput, expiredResidual.mysql),
    {
      ok: true,
      actionId: legacyInput.actionId,
      teamId: legacyInput.teamId,
      epoch: legacyInput.epoch,
      generation: null,
      measurements: {
        lease: { activeOwnerCount: 0, ownerNodeId: null, legacyOwnerActive: false },
      },
    },
  );
  for (const leaseRows of [
    [
      { owner_node_id: identities[2].legacyNodeId, status: "running", lease_active: 1 },
      { owner_node_id: "duplicate", status: "running", lease_active: 1 },
    ],
    [{ owner_node_id: identities[2].legacyNodeId, status: "active", lease_active: 1 }],
    [{ owner_node_id: identities[2].legacyNodeId, status: "running", lease_active: true }],
    [{ owner_node_id: identities[2].legacyNodeId, status: "running", lease_active: 1 }],
    [{ owner_node_id: "different-owner", status: "running", lease_active: 1 }],
  ]) {
    const fixture = measurementFixture(legacyInput, { leaseRows });
    const error = await captureRejection(
      () => executeStagingPhase3ActionMeasurementPayload(legacyInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
    assert.equal(error.message.includes(legacyInput.connection.password), false);
  }
  for (const leaseRows of [
    [],
    [{ owner_node_id: identities[1].legacyNodeId, status: "running", lease_active: 0 }],
    [{ owner_node_id: "different-owner", status: "running", lease_active: 1 }],
    [{ owner_node_id: identities[1].legacyNodeId, status: "active", lease_active: 1 }],
    [
      { owner_node_id: identities[1].legacyNodeId, status: "running", lease_active: 1 },
      { owner_node_id: identities[1].legacyNodeId, status: "running", lease_active: 1 },
    ],
  ]) {
    const fixture = measurementFixture(inlineInput, { leaseRows });
    await assert.rejects(
      () => executeStagingPhase3ActionMeasurementPayload(inlineInput, fixture.mysql),
    );
    assert.equal(fixture.state.endCount, 1);
  }

  const schemaObservation = {
    schemaVersion: 1,
    observationId: "phase3-schema-verify",
    requiredTerminalActionId: "staging-gate-3-handoff",
    teamId: payload.teamId,
    epoch: payload.epoch,
    pollerNodeId: payload.pollerNodeId,
    releaseContext,
    connection: observerConnection,
  };
  assert.deepEqual(
    validateStagingPhase3ObservationPayload(schemaObservation),
    schemaObservation,
  );
  assert.deepEqual(
    validateStagingPhase3ObservationPayload({
      ...schemaObservation,
      releaseContext: {
        ...releaseContext,
        schema: { min: 37, max: 37 },
        rollbackSchema: { min: 37, max: 37 },
      },
    }).releaseContext.schema,
    { min: 37, max: 37 },
  );
  const maximumLengthRunId = `r${"x".repeat(127)}`;
  assert.equal(
    validateStagingPhase3ObservationPayload({
      ...schemaObservation,
      releaseContext: { ...releaseContext, stagingRunId: maximumLengthRunId },
    }).releaseContext.stagingRunId,
    maximumLengthRunId,
  );
  assert.throws(
    () => validateStagingPhase3ObservationPayload({
      ...schemaObservation,
      releaseContext: {
        ...releaseContext,
        rollbackMigrations: releaseContext.rollbackMigrations.map((migration) =>
          migration.filename === "035_create_auto_accept_publication_controls.sql"
            ? { ...migration, sha256: "0".repeat(64) }
            : migration),
      },
    }),
    /rollback|migration|checksum|coverage/i,
  );
  const schemaRows = [
    {
      name: "035_create_auto_accept_publication_controls.sql",
      checksum_sha256: "2".repeat(64),
      status: "applied",
    },
    {
      name: "036_create_gate6_control_plane.sql",
      checksum_sha256: "3".repeat(64),
      status: "applied",
    },
    {
      name: "037_create_n_minus_one_probe_fixtures.sql",
      checksum_sha256: "4".repeat(64),
      status: "applied",
    },
  ];
  function schemaObserverMysql(rows = schemaRows) {
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    let endCount = 0;
    return {
      calls,
      get endCount() { return endCount; },
      mysql: {
        async createConnection() {
          return {
            async execute(sql: string, parameters: unknown[]) {
              calls.push({ sql, parameters });
              if (/FROM schema_migrations/.test(sql)) return [rows, []];
              throw new Error(`unexpected observer SQL: ${sql}`);
            },
            async end() { endCount += 1; },
          };
        },
      },
    };
  }
  const observer = schemaObserverMysql();
  const schemaResult = await executeStagingPhase3ObservationPayload(
    schemaObservation,
    observer.mysql,
    observationClock,
  );
  assert.deepEqual(
    schemaResult,
    {
      ok: true,
      observationId: "phase3-schema-verify",
      requiredTerminalActionId: "staging-gate-3-handoff",
      teamId: payload.teamId,
      epoch: payload.epoch,
      pollerNodeId: payload.pollerNodeId,
      generation: null,
      observedAt: "2026-07-12T10:31:00.000Z",
      measurements: {
        candidateSchemaVersion: 37,
        schemaMaximum: 37,
        rollbackSchemaMinimum: 35,
        rollbackSchemaMaximum: 37,
        candidateSchemaRangeDeclared: true,
        nMinusOneSchemaRangeDeclared: true,
        migration035ChecksumMatches: true,
        pendingMigrations: 0,
        runningMigrations: 0,
        failedMigrations: 0,
        observerReadOnly: true,
      },
    },
  );
  assert.deepEqual(Object.keys(schemaResult).sort(), [
    "epoch",
    "generation",
    "measurements",
    "observationId",
    "observedAt",
    "ok",
    "pollerNodeId",
    "requiredTerminalActionId",
    "teamId",
  ].sort());
  assert.equal(JSON.stringify(schemaResult).includes(observerConnection.password), false);
  assert.equal(observer.endCount, 1);
  assert.equal(observer.calls.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  for (const status of ["pending", "running", "failed"]) {
    const invalid = schemaObserverMysql(schemaRows.map((row, index) =>
      index === 2 ? { ...row, status } : row));
    await assert.rejects(
      () => executeStagingPhase3ObservationPayload(
        schemaObservation,
        invalid.mysql,
        observationClock,
      ),
      /migration|pending|running|failed|applied/i,
    );
    assert.equal(invalid.endCount, 1);
  }

  const fenceObservation = {
    ...schemaObservation,
    observationId: "phase3-fence-ack-wait",
    requiredTerminalActionId: "phase3-publication-fence",
  };
  const fenceRow = {
    team_id: payload.teamId,
    cutover_epoch: payload.epoch,
    publication_generation: 7,
    state: "fenced",
    poller_node_id: payload.pollerNodeId,
    fence_job_id: 10,
    ack_node_id: payload.pollerNodeId,
    ack_job_id: 11,
    acknowledged_at: "2026-07-11T00:00:00.000Z",
    is_active: 1,
    active_epoch: payload.epoch,
    active_generation: 7,
  };
  function fenceObserverMysql(row: Record<string, unknown>) {
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    let endCount = 0;
    return {
      calls,
      get endCount() { return endCount; },
      mysql: {
        async createConnection() {
          return {
            async execute(sql: string, parameters: unknown[]) {
              calls.push({ sql, parameters });
              return [[row], []];
            },
            async end() { endCount += 1; },
          };
        },
      },
    };
  }
  const fenceObserver = fenceObserverMysql(fenceRow);
  const fenceResult = await executeStagingPhase3ObservationPayload(
    fenceObservation,
    fenceObserver.mysql,
    observationClock,
  );
  assert.deepEqual(
    fenceResult,
    {
      ok: true,
      observationId: "phase3-fence-ack-wait",
      requiredTerminalActionId: "phase3-publication-fence",
      teamId: payload.teamId,
      epoch: payload.epoch,
      pollerNodeId: payload.pollerNodeId,
      generation: 7,
      observedAt: "2026-07-12T10:31:00.000Z",
      measurements: {
        state: "fenced",
        publicationGeneration: 7,
        fenceJobId: 10,
        ackJobId: 11,
        pollerNodeId: payload.pollerNodeId,
        ackNodeId: payload.pollerNodeId,
        acknowledgedAt: "2026-07-11T00:00:00.000Z",
        isActive: true,
        observerReadOnly: true,
      },
    },
  );
  assert.deepEqual(fenceObserver.calls[0].parameters, [payload.teamId, payload.epoch]);
  assert.equal(fenceObserver.calls.some(({ sql }) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  assert.equal(fenceObserver.endCount, 1);
  assert.deepEqual(Object.keys(fenceResult).sort(), Object.keys(schemaResult).sort());
  assert.equal(JSON.stringify(fenceResult).includes(observerConnection.password), false);
  for (const invalidRow of [
    { ...fenceRow, ack_node_id: null },
    { ...fenceRow, acknowledged_at: null },
    { ...fenceRow, poller_node_id: "wrong-poller" },
    { ...fenceRow, ack_node_id: "wrong-poller" },
    { ...fenceRow, ack_job_id: 9 },
  ]) {
    const invalid = fenceObserverMysql(invalidRow);
    await assert.rejects(
      () => executeStagingPhase3ObservationPayload(
        fenceObservation,
        invalid.mysql,
        observationClock,
      ),
      /fence|acknowledg|poller|node|tuple|watermark/i,
    );
    assert.equal(invalid.endCount, 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
