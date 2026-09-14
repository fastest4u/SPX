import assert from "node:assert/strict";
import {
  buildRuntimeStatusReadModel,
  projectPublicRuntimeStatusReadModel,
} from "../src/services/runtime-status-read-model.js";

const generatedAt = "2030-01-01T00:02:00.000Z";

const autoAcceptSummary = {
  total: 0,
  byStatus: {
    pending: 0,
    claimed: 0,
    retrying: 0,
    verifying: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    dead_letter: 0,
    cancelled: 0,
  },
  byAttemptKind: {
    pending_request: 0,
    non_pending_probe: 0,
    fast_accept_all: 0,
    own_status_reconcile: 0,
  },
  claimableCount: 0,
  expiredClaimCount: 0,
  inFlightCount: 0,
  terminalCount: 0,
  settlementPendingCount: 0,
  budgetReservations: {
    activeCount: 0,
    staleCount: 0,
    oldestHeldAt: null,
    oldestHeldAgeMs: null,
    staleTtlMs: 0,
  },
  deadLetters: {
    total: 0,
    byReasonCode: {
      invalid_payload: 0,
      identity_mismatch: 0,
      configuration_error: 0,
      execution_failure: 0,
      verification_indeterminate: 0,
      progress_persistence_failure: 0,
      result_persistence_failure: 0,
      history_persistence_failure: 0,
      notification_persistence_failure: 0,
      unsupported_job: 0,
      other: 0,
    },
    groups: [],
  },
};

function runtimeNode(
  lastHeartbeatAt: unknown,
  role = "auto-accept-service",
  enabledLoopModes?: unknown[],
) {
  return {
    nodeId: `${role}-node-1`,
    role,
    hostname: null,
    pid: null,
    version: null,
    lastHeartbeatAt,
    metadataJson: JSON.stringify({
      assignedTeamIds: [3, 1, 3, 0, -1, 2.5, "2"],
      enabledLoopModes: enabledLoopModes ?? [
        ...(role === "poller-service"
          ? ["poller", "poller"]
          : ["autoAcceptSettlement", "autoAcceptReal", "autoAcceptReal"]),
        "unsupported-mode",
      ],
      secret: "metadata-secret-must-not-leak",
      cookie: "metadata-cookie-must-not-leak",
      internalUrl: "http://private-runtime.internal",
      nested: { password: "metadata-password-must-not-leak" },
    }),
    createdAt: "2029-12-31T23:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function build(
  lastHeartbeatAt: unknown,
  serviceHealth: unknown[] = [],
  role = "auto-accept-service",
  enabledLoopModes?: unknown[],
) {
  const value = buildRuntimeStatusReadModel({
    scope: { kind: "admin" },
    generatedAt,
    records: {
      nodes: [runtimeNode(lastHeartbeatAt, role, enabledLoopModes)],
      leases: [],
      notifications: {},
      serviceHealth,
      providerDeliveryRows: [],
      ocrSummary: { completedExtractions: 0, lastCompletedAt: null },
      autoAcceptJobSummary: autoAcceptSummary,
    } as never,
  });
  return projectPublicRuntimeStatusReadModel(value);
}

const exactBoundary = build("2030-01-01T00:00:00.000Z");
assert.deepEqual(exactBoundary.nodes[0]?.assignedTeamIds, [1, 3]);
assert.deepEqual(exactBoundary.nodes[0]?.enabledLoopModes, [
  "autoAcceptReal",
  "autoAcceptSettlement",
]);
assert.deepEqual(exactBoundary.nodes[0]?.heartbeat, {
  state: "fresh",
  ageMs: 120_000,
  staleAfterMs: 120_000,
});
assert.equal(exactBoundary.nodes[0]?.lastHeartbeatAt, "2030-01-01T00:00:00.000Z");
assert.equal(exactBoundary.readModels.deployVersion.services[0]?.state, "unknown");

const mysqlTimestamp = build("2030-01-01 00:00:00");
assert.equal(mysqlTimestamp.nodes[0]?.lastHeartbeatAt, "2030-01-01 00:00:00");
assert.equal(mysqlTimestamp.nodes[0]?.heartbeat?.state, "fresh");

const serialized = JSON.stringify(exactBoundary);
for (const forbidden of [
  "metadataJson",
  "metadata-secret-must-not-leak",
  "metadata-cookie-must-not-leak",
  "metadata-password-must-not-leak",
  "private-runtime.internal",
  "unsupported-mode",
]) {
  assert.equal(serialized.includes(forbidden), false, forbidden);
}

const stale = build("2029-12-31T23:59:59.999Z");
assert.deepEqual(stale.nodes[0]?.heartbeat, {
  state: "degraded",
  ageMs: 120_001,
  staleAfterMs: 120_000,
});
assert.equal(stale.readModels.deployVersion.services[0]?.state, "degraded");

const stalePoller = build("2029-12-31T23:59:59.999Z", [], "poller-service");
assert.deepEqual(stalePoller.nodes[0]?.enabledLoopModes, ["poller"]);
assert.equal(stalePoller.nodes[0]?.heartbeat?.state, "degraded");
assert.equal(stalePoller.readModels.deployVersion.services[0]?.state, "degraded");

const pollerWithCrossRoleMode = build(
  "2030-01-01T00:00:00.000Z",
  [],
  "poller-service",
  ["poller", "autoAcceptReal"],
);
assert.deepEqual(pollerWithCrossRoleMode.nodes[0]?.enabledLoopModes, ["poller"]);

const autoAcceptWithCrossRoleMode = build(
  "2030-01-01T00:00:00.000Z",
  [],
  "auto-accept-service",
  ["poller", "autoAcceptReal"],
);
assert.deepEqual(autoAcceptWithCrossRoleMode.nodes[0]?.enabledLoopModes, ["autoAcceptReal"]);

const staleWithNominalHealth = build("2029-12-31T23:59:59.999Z", [{
  service: "auto-accept-service",
  role: "auto-accept-service",
  nodeId: "auto-accept-node-1",
  state: "ok",
  checkedAt: generatedAt,
  details: {},
}]);
assert.equal(staleWithNominalHealth.readModels.deployVersion.services[0]?.state, "degraded");

for (const invalidHeartbeat of ["not-a-timestamp", new Date(Number.NaN), null]) {
  const invalid = build(invalidHeartbeat);
  assert.equal(invalid.nodes[0]?.lastHeartbeatAt, null);
  assert.deepEqual(invalid.nodes[0]?.heartbeat, {
    state: "degraded",
    ageMs: null,
    staleAfterMs: 120_000,
  });
  assert.equal(invalid.readModels.deployVersion.services[0]?.lastHeartbeatAt, null);
  assert.equal(invalid.readModels.deployVersion.services[0]?.state, "degraded");
}
