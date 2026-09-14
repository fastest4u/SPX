import assert from "node:assert/strict";
import { buildRuntimeStatusReadModel } from "../src/services/runtime-status-read-model.js";

const generatedAt = "2030-01-01T00:00:00.000Z";
const nodes = [
  { nodeId: "worker-2", role: "worker", hostname: "host-2", version: "v2", lastHeartbeatAt: generatedAt, metadataJson: null },
  { nodeId: "worker-3", role: "worker", hostname: "host-3", version: "v3", lastHeartbeatAt: generatedAt, metadataJson: null },
] as never;
const leases = [
  { teamId: 2, ownerNodeId: "worker-2", ownerRole: "worker", status: "active", heartbeatAt: generatedAt, leaseExpiresAt: "2030-01-01T00:01:00.000Z", lastError: null },
  { teamId: 3, ownerNodeId: "worker-3", ownerRole: "worker", status: "active", heartbeatAt: generatedAt, leaseExpiresAt: "2030-01-01T00:01:00.000Z", lastError: "secret team 3 error" },
] as never;

const common = {
  generatedAt,
  records: {
    nodes,
    leases,
    notifications: { queued: 4, provider_sending: 2, delivery_ambiguous: 3 },
    serviceHealth: [{ service: "line-service", role: "line-service", nodeId: "line-1", state: "ok" }],
    providerDeliveryRows: [],
    ocrSummary: { completedExtractions: 2, lastCompletedAt: generatedAt },
    autoAcceptJobSummary: {
      total: 3,
      byStatus: {},
      byAttemptKind: {},
      claimableCount: 1,
      expiredClaimCount: 0,
      inFlightCount: 1,
      terminalCount: 1,
      settlementPendingCount: 0,
      budgetReservations: {},
      deadLetters: {
        total: 2,
        byReasonCode: {
          invalid_payload: 1,
          identity_mismatch: 0,
          configuration_error: 0,
          execution_failure: 0,
          verification_indeterminate: 0,
          progress_persistence_failure: 0,
          result_persistence_failure: 0,
          history_persistence_failure: 0,
          notification_persistence_failure: 0,
          unsupported_job: 0,
          other: 1,
        },
        groups: [
          { teamId: 2, attemptKind: "pending_request", reasonCode: "invalid_payload", count: 1, rawReason: "malformed_payload" },
          { teamId: 3, attemptKind: "fast_accept_all", reasonCode: "other", count: 1, rawReason: "token=raw-secret" },
        ],
        lastError: "raw read-model error must stay private",
        payloadJson: "raw read-model payload must stay private",
        jobId: 99123,
        traceId: "raw-read-model-trace",
      },
    },
  },
} as never;

const admin = buildRuntimeStatusReadModel({ ...common, scope: { kind: "admin" } });
assert.equal(admin.nodes.length, 2);
assert.equal(admin.leases.length, 2);
assert.equal(admin.notifications.queued, 4);
assert.equal(admin.notifications.provider_sending, 2);
assert.equal(admin.notifications.delivery_ambiguous, 3);
assert.ok(admin.readModels.notificationQueue);
assert.equal(admin.readModels.notificationQueue.byStatus.provider_sending, 2);
assert.equal(admin.readModels.notificationQueue.byStatus.delivery_ambiguous, 3);
assert.equal(admin.readModels.notificationQueue.reconciliationRequiredCount, 5);
assert.ok(admin.readModels.autoAcceptJobs);
assert.ok(admin.readModels.ocr);
assert.deepEqual(admin.readModels.autoAcceptJobs.deadLetters, {
  total: 2,
  byReasonCode: {
    invalid_payload: 1,
    identity_mismatch: 0,
    configuration_error: 0,
    execution_failure: 0,
    verification_indeterminate: 0,
    progress_persistence_failure: 0,
    result_persistence_failure: 0,
    history_persistence_failure: 0,
    notification_persistence_failure: 0,
    unsupported_job: 0,
    other: 1,
  },
  groups: [
    { teamId: 2, attemptKind: "pending_request", reasonCode: "invalid_payload", count: 1 },
    { teamId: 3, attemptKind: "fast_accept_all", reasonCode: "other", count: 1 },
  ],
});
const adminAutoAcceptJson = JSON.stringify(admin.readModels.autoAcceptJobs);
for (const forbidden of [
  "malformed_payload",
  "token=raw-secret",
  "raw read-model error must stay private",
  "raw read-model payload must stay private",
  "99123",
  "raw-read-model-trace",
]) {
  assert.equal(adminAutoAcceptJson.includes(forbidden), false, `runtime read model leaked ${forbidden}`);
}

const team = buildRuntimeStatusReadModel({ ...common, scope: { kind: "team", teamId: 2 } });
assert.deepEqual(team.nodes.map((node: { nodeId: string }) => node.nodeId), ["worker-2"]);
assert.deepEqual(team.leases.map((lease: { teamId: number }) => lease.teamId), [2]);
assert.deepEqual(team.notifications, {});
assert.deepEqual(team.serviceHealth, []);
assert.equal(team.readModels.notificationQueue, null);
assert.equal(team.readModels.autoAcceptJobs, null);
assert.equal(team.readModels.ocr, null);
assert.deepEqual(team.readModels.workerLeases.teams.map((entry: { teamId: number }) => entry.teamId), [2]);
assert.equal(JSON.stringify(team).includes("secret team 3 error"), false);
