import assert from "node:assert/strict";

import { REQUIRED_STAGING_ACTION_PLAN } from "../scripts/lib/staging-action-plan.mjs";
import {
  STAGING_STOP_SERVICE_ALLOWLIST,
  assertAllowedStagingServices,
  assertLocalStagingDocker,
  buildStagingGuardComposePrefix,
  buildStagingStopCommand,
  executeGuardDecision,
  executeStagingStopAction,
  evaluateGuardDecision,
  runCapacityGuard,
} from "../scripts/a3-capacity-guard.mjs";

const leases = {
  stagingRunId: "staging-run-001",
  guard: { leaseId: "guard-001", heartbeatMonotonicMs: 9_900 },
  watchdog: { leaseId: "watchdog-001", heartbeatMonotonicMs: 9_850 },
};
const operatorRoot = `/opt/spx-staging/release/${"a".repeat(40)}/operator`;

async function main(): Promise<void> {
assert.deepEqual(
  evaluateGuardDecision({
    capacity: { ok: true, failures: [] },
    leases,
    stagingRunId: leases.stagingRunId,
    nowMonotonicMs: 10_000,
    maxLeaseAgeMs: 500,
    consecutiveBreaches: 0,
    requiredBreaches: 3,
    emergencyActionAvailable: true,
  }),
  { ok: true, stop: false, nextConsecutiveBreaches: 0, failures: [] },
);

const thirdBreach = evaluateGuardDecision({
  capacity: { ok: false, failures: ["PRODUCTION_NOT_READY"] },
  leases,
  stagingRunId: leases.stagingRunId,
  nowMonotonicMs: 10_000,
  maxLeaseAgeMs: 500,
  consecutiveBreaches: 2,
  requiredBreaches: 3,
  emergencyActionAvailable: true,
});
assert.equal(thirdBreach.stop, true);
assert.equal(thirdBreach.actionId, "staging-guard-emergency-stop");
assert.deepEqual(thirdBreach.failures, ["PRODUCTION_NOT_READY"]);

const consumed: string[] = [];
const services = ["web-api", "line-service", "ocr-service", "worker-ifn-split"];
assert.equal(
  (
    await executeGuardDecision(
      {
        capacity: { ok: false, failures: ["PRODUCTION_NOT_READY"] },
        leases,
        stagingRunId: leases.stagingRunId,
        nowMonotonicMs: 10_000,
        maxLeaseAgeMs: 500,
        consecutiveBreaches: 2,
        requiredBreaches: 3,
        emergencyActionAvailable: true,
      },
      async (actionId: string) => consumed.push(actionId),
    )
  ).stop,
  true,
);
assert.deepEqual(consumed, ["staging-guard-emergency-stop"]);

const stopEvents: string[] = [];
assert.deepEqual(
  await executeStagingStopAction("staging-guard-emergency-stop", {
    operatorRoot,
    async definedServices() {
      return services;
    },
    async runDocker(command: string[]) {
      stopEvents.push(command.join(" "));
    },
  }),
  { ok: true, actionId: "staging-guard-emergency-stop", serviceCount: services.length },
);
assert.equal(stopEvents.length, 1);
assert.match(stopEvents[0], /compose -p spx-staging/);

const lifecycleEvents: string[] = [];
const lifecycleResult = await runCapacityGuard({
  async loadContext() {
    return { installedBinding: { stagingRunId: leases.stagingRunId } };
  },
  async assertNoLiveLease() {
    return null;
  },
  now() {
    return 10_000;
  },
  async writeLease(_role: string, lease: { state: string }) {
    lifecycleEvents.push(`lease:${lease.state}`);
  },
  async collectCapacity() {
    return {
      stagingRunId: leases.stagingRunId,
      snapshot: { productionP95LatencyMs: 80 },
      thresholds: {},
    };
  },
  async loadLeases() {
    return { stagingRunId: leases.stagingRunId, guard: leases.guard, watchdog: null };
  },
  async consumeEmergencyAction(actionId: string) {
    lifecycleEvents.push(`consume:${actionId}`);
  },
  async sleep() {
    throw new Error("guard should stop before sleeping");
  },
});
assert.equal(lifecycleResult.stop, true);
assert.ok(lifecycleEvents.includes("consume:staging-guard-emergency-stop"));
assert.equal(lifecycleEvents.at(-1), "lease:aborted");

const noLedger = evaluateGuardDecision({
  capacity: { ok: false, failures: ["PRODUCTION_NOT_READY"] },
  leases,
  stagingRunId: leases.stagingRunId,
  nowMonotonicMs: 10_000,
  maxLeaseAgeMs: 500,
  consecutiveBreaches: 2,
  requiredBreaches: 3,
  emergencyActionAvailable: false,
});
assert.equal(noLedger.stop, false);
assert.deepEqual(noLedger.failures, ["ACTION_LEDGER_UNAVAILABLE"]);

assert.deepEqual(assertAllowedStagingServices(services), services);
assert.throws(() => assertAllowedStagingServices([...services, "production-api"]), /allowlist/i);
assert.deepEqual(buildStagingStopCommand(services, operatorRoot), [
  ...buildStagingGuardComposePrefix(operatorRoot),
  "stop",
  ...services,
]);
assert.deepEqual(buildStagingGuardComposePrefix(operatorRoot).slice(-2), ["--profile", "*"]);
assert.ok(STAGING_STOP_SERVICE_ALLOWLIST.includes("staging-db-proxy"));
for (const service of [
  "gate6-control",
  "gate6-task9-controller",
  "gate6-db-proxy",
  "gate6-monitor-probe",
  "n-minus-one-db-proxy",
  "n-minus-one-web-probe",
  "n-minus-one-notification-probe",
  "n-minus-one-line-probe",
  "n-minus-one-ocr-probe",
  "n-minus-one-worker-ifn-probe",
  "n-minus-one-worker-ptwl-probe",
]) {
  assert.ok(STAGING_STOP_SERVICE_ALLOWLIST.includes(service), `${service} must be stoppable`);
}
assert.doesNotThrow(() => assertLocalStagingDocker({ dockerContext: "default" }));
assert.throws(
  () => assertLocalStagingDocker({ dockerContext: "default", dockerHost: "ssh://production" }),
  /DOCKER_HOST|remote/i,
);
assert.deepEqual(
  REQUIRED_STAGING_ACTION_PLAN.filter((action) => action.kind === "emergency").map(
    (action) => action.actionId,
  ),
  ["staging-guard-emergency-stop", "staging-watchdog-emergency-stop"],
);

console.log("A3 capacity guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
