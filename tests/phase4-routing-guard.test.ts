import assert from "node:assert/strict";

import {
  PHASE4_ROUTING_ACTION_IDS,
  allowedServicesForRoutingMutation,
  executePhase4RoutingMutation,
  validateRoutingPlan,
  validateRoutingTransition,
} from "../scripts/phase4-routing-guard.mjs";

const valid = {
  environment: "staging",
  composeProject: "spx-staging",
  releaseSha: "a".repeat(40),
  producers: ["poller", "notification", "line"],
  webReadsRemote: false,
  webStreamsRemote: false,
  routingWatermark: 120,
};

async function main(): Promise<void> {
assert.deepEqual(validateRoutingPlan(valid), { ok: true, failures: [] });
assert.equal(validateRoutingPlan({ ...valid, producers: ["unknown"] }).ok, false);
assert.equal(validateRoutingPlan({ ...valid, environment: "production" }).ok, false);
assert.equal(validateRoutingPlan({ ...valid, producers: ["poller", "poller"] }).ok, false);

const local = {
  ...valid,
  producers: [],
  routingWatermark: 100,
  localFallbackWatermark: 100,
  singletonOwners: 1,
};
const selected = {
  ...local,
  producers: ["poller"],
  routingWatermark: 105,
  localFallbackWatermark: 105,
};
const allRemote = { ...selected, producers: valid.producers, routingWatermark: 110, localFallbackWatermark: 110 };
const readsRemote = { ...allRemote, webReadsRemote: true };
const streamsRemote = { ...readsRemote, webStreamsRemote: true };

assert.equal(validateRoutingTransition(local, selected, "producer").ok, true);
assert.equal(validateRoutingTransition(selected, allRemote, "producer").ok, true);
assert.equal(validateRoutingTransition(allRemote, readsRemote, "read").ok, true);
assert.equal(validateRoutingTransition(readsRemote, streamsRemote, "stream").ok, true);
assert.equal(
  validateRoutingTransition(
    streamsRemote,
    { ...local, routingWatermark: 110, localFallbackWatermark: 110 },
    "local-rollback",
  ).ok,
  true,
);
assert.deepEqual(
  validateRoutingTransition(local, readsRemote, "read").failures,
  ["ROUTING_TRANSITION_SKIPPED"],
);
assert.deepEqual(
  validateRoutingTransition(
    streamsRemote,
    { ...local, routingWatermark: 110, localFallbackWatermark: 109 },
    "local-rollback",
  ).failures,
  ["LOCAL_FALLBACK_BEHIND_ROUTING_WATERMARK"],
);
assert.deepEqual(
  validateRoutingTransition(local, { ...selected, releaseSha: "b".repeat(40) }, "producer").failures,
  ["ROUTING_RELEASE_BINDING_CHANGED"],
);
assert.deepEqual(
  validateRoutingTransition(local, { ...selected, singletonOwners: 2 }, "producer").failures,
  ["REALTIME_SINGLETON_VIOLATION"],
);

assert.deepEqual(allowedServicesForRoutingMutation("producer", selected), ["poller"]);
assert.deepEqual(allowedServicesForRoutingMutation("read", readsRemote), ["web-api"]);
assert.deepEqual(allowedServicesForRoutingMutation("stream", streamsRemote), ["web-api"]);
assert.throws(() => allowedServicesForRoutingMutation("producer", { ...selected, producers: ["unknown"] }), /routing plan/i);

assert.deepEqual(PHASE4_ROUTING_ACTION_IDS, {
  producer: "phase4-route-producer",
  read: "phase4-route-read",
  stream: "phase4-route-stream",
  localRollback: "phase4-route-local-rollback",
  approvedFinal: "phase4-route-approved-final",
  finalCleanupBaseline: "phase4-route-final-cleanup-baseline",
});
assert.notEqual(
  PHASE4_ROUTING_ACTION_IDS.localRollback,
  PHASE4_ROUTING_ACTION_IDS.finalCleanupBaseline,
);

const events: string[] = [];
assert.deepEqual(
  await executePhase4RoutingMutation(local, selected, "producer", {
    inheritedAction: {
      actionId: PHASE4_ROUTING_ACTION_IDS.producer,
      releaseSha: valid.releaseSha,
      stagingRunId: "staging-run-001",
    },
    stagingRunId: "staging-run-001",
    async apply(services: string[]) {
      events.push(`apply:${services.join(",")}`);
    },
  }),
  { ok: true, actionId: "phase4-route-producer", services: ["poller"] },
);
assert.deepEqual(events, ["apply:poller"]);

console.log("Phase 4 routing guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
