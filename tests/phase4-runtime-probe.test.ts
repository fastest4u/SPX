import assert from "node:assert/strict";

import {
  evaluatePhase4Probe,
  parsePhase4ProbeArgs,
} from "../scripts/phase4-runtime-probe.mjs";

const valid = {
  releaseEnvironment: "staging",
  runtimeEnvironment: "staging",
  drillMode: "staging",
  composeProject: "spx-staging",
  stagingRunId: "staging-a3-20260710-01",
  approvalEnvelopeSha256: "a".repeat(64),
  targetDescriptorValid: true,
  operatorBundleValid: true,
  a3HostIdentityMatches: true,
  guardSameInstance: true,
  guardHeartbeatFresh: true,
  watchdogHeartbeatFresh: true,
  baselineLeaseOwnerExact: true,
  runtimeIdentitiesExact: true,
  databaseRoutingExact: true,
  stagingWebReady: true,
  productionWebReady: true,
  workerAlive: true,
  directDbPublishersHealthy: true,
  realtimeReady: true,
  realtimeUnavailable: false,
  targetedReaderDegraded: false,
  localFallbackUsable: true,
  competingOwnerRejected: true,
  producersRemote: true,
  webReadsRemote: true,
  webStreamsRemote: true,
  singletonOwners: 1,
  latestEventId: 120,
  replayCursor: 120,
  localFallbackWatermark: 120,
  routingWatermark: 120,
};

assert.deepEqual(evaluatePhase4Probe(valid, "baseline"), { ok: true, failures: [] });
assert.deepEqual(
  evaluatePhase4Probe({ ...valid, singletonOwners: 2 }, "baseline").failures,
  ["REALTIME_SINGLETON_VIOLATION"],
);
assert.deepEqual(
  evaluatePhase4Probe({ ...valid, localFallbackWatermark: 119 }, "rollback").failures,
  ["LOCAL_FALLBACK_BEHIND_ROUTING_WATERMARK"],
);
assert.deepEqual(
  evaluatePhase4Probe({ ...valid, guardSameInstance: false }, "baseline").failures,
  ["GUARD_HANDOFF_CHANGED"],
);
assert.deepEqual(
  evaluatePhase4Probe({ ...valid, targetDescriptorValid: false }, "baseline").failures,
  ["TARGET_DESCRIPTOR_INVALID"],
);
const dbFaultValid = {
  ...valid,
  realtimeReady: false,
  realtimeUnavailable: true,
  targetedReaderDegraded: true,
};
assert.deepEqual(
  evaluatePhase4Probe(dbFaultValid, "db-fault"),
  { ok: true, failures: [] },
);
assert.deepEqual(
  evaluatePhase4Probe({ ...dbFaultValid, productionWebReady: false }, "db-fault").failures,
  ["PRODUCTION_WEB_NOT_READY"],
);
assert.deepEqual(
  evaluatePhase4Probe({ ...valid, databaseRoutingExact: false }, "routed").failures,
  ["DATABASE_ROUTING_CLASSIFICATION_INVALID"],
);

assert.deepEqual(parsePhase4ProbeArgs(["--mode=baseline"]), { mode: "baseline" });
assert.deepEqual(parsePhase4ProbeArgs(["--mode=rollback"]), { mode: "rollback" });
for (const args of [
  [],
  ["--mode=production"],
  ["--mode=baseline", "--url=https://production.example"],
]) {
  assert.throws(() => parsePhase4ProbeArgs(args), /mode|override/i);
}

console.log("Phase 4 runtime probe tests passed");
