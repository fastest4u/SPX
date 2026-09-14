import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateWatchdogDecision,
  executeWatchdogDecision,
} from "../scripts/a3-capacity-watchdog.mjs";

const healthy = {
  stagingRunId: "staging-run-001",
  guardLease: { leaseId: "guard-001", stagingRunId: "staging-run-001", heartbeatMonotonicMs: 9_900 },
  watchdogLease: {
    leaseId: "watchdog-001",
    stagingRunId: "staging-run-001",
    heartbeatMonotonicMs: 9_950,
  },
  nowMonotonicMs: 10_000,
  maxLeaseAgeMs: 500,
  emergencyActionAvailable: true,
};

async function main(): Promise<void> {
assert.deepEqual(evaluateWatchdogDecision(healthy), { ok: true, stop: false, failures: [] });
assert.deepEqual(
  evaluateWatchdogDecision({
    ...healthy,
    guardLease: { ...healthy.guardLease, heartbeatMonotonicMs: 9_000 },
  }),
  {
    ok: false,
    stop: true,
    actionId: "staging-watchdog-emergency-stop",
    failures: ["GUARD_LEASE_STALE"],
  },
);
assert.deepEqual(
  evaluateWatchdogDecision({
    ...healthy,
    guardLease: { ...healthy.guardLease, heartbeatMonotonicMs: 9_000 },
    emergencyActionAvailable: false,
  }).failures,
  ["ACTION_LEDGER_UNAVAILABLE"],
);

const consumed: string[] = [];
await executeWatchdogDecision(
  {
    ...healthy,
    guardLease: { ...healthy.guardLease, heartbeatMonotonicMs: 9_000 },
  },
  async (actionId: string) => consumed.push(actionId),
);
assert.deepEqual(consumed, ["staging-watchdog-emergency-stop"]);

for (const unit of [
  "deploy/systemd/spx-a3-capacity-guard.service",
  "deploy/systemd/spx-a3-capacity-watchdog.service",
]) {
  const source = readFileSync(unit, "utf8");
  assert.match(source, /^User=root$/m);
  assert.match(source, /^Restart=always$/m);
  assert.match(source, /^RestartSec=\d+s$/m);
  assert.match(source, /^RuntimeDirectory=spx-staging-rollout$/m);
  assert.match(source, /UMask=0077/);
  assert.doesNotMatch(source, /production|ssh:\/\/|DOCKER_HOST/i);
}

console.log("A3 capacity watchdog tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
