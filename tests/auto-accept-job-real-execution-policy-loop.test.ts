import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { setTeamRuntimeDesiredState } from "../src/repositories/runtime-repository.js";
import { createTeam, updateTeam } from "../src/repositories/team-repository.js";
import {
  loadAutoAcceptJobRealApiClientForTeam,
  loadAutoAcceptJobRealNewAttemptPolicyForTeam,
  runAutoAcceptJobRealWorkerOnce,
} from "../src/services/auto-accept-job-real-execution-loop.js";
import type { AutoAcceptWorkerBatchResult } from "../src/services/auto-accept-worker.js";

function emptySummary(overrides: Partial<AutoAcceptWorkerBatchResult> = {}): AutoAcceptWorkerBatchResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
    ...overrides,
  };
}

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

async function main(): Promise<void> {
  await resetDb();

  const enabledTeam = await createTeam({
    name: "Enabled policy team",
    enabled: true,
    spxCookie: "enabled-cookie",
    spxDeviceId: "enabled-device",
  });
  assert.equal(await loadAutoAcceptJobRealNewAttemptPolicyForTeam(enabledTeam.id), true);

  await setTeamRuntimeDesiredState({ teamId: enabledTeam.id, desiredState: "running" });
  assert.equal(await loadAutoAcceptJobRealNewAttemptPolicyForTeam(enabledTeam.id), true);

  for (const desiredState of ["paused", "stopped", "restart"] as const) {
    await setTeamRuntimeDesiredState({ teamId: enabledTeam.id, desiredState });
    assert.equal(
      await loadAutoAcceptJobRealNewAttemptPolicyForTeam(enabledTeam.id),
      false,
      desiredState,
    );
  }

  await setTeamRuntimeDesiredState({ teamId: enabledTeam.id, desiredState: "running" });
  await updateTeam(enabledTeam.id, { enabled: false });
  assert.equal(await loadAutoAcceptJobRealNewAttemptPolicyForTeam(enabledTeam.id), false);
  assert.equal(await loadAutoAcceptJobRealNewAttemptPolicyForTeam(999_999), false);

  const disabledApiClient = await loadAutoAcceptJobRealApiClientForTeam(enabledTeam.id);
  assert.ok(disabledApiClient, "disabled teams retain credentials for marker recovery reads");

  let runBatchCalls = 0;
  let policyAllowed: boolean | null = null;
  const summary = await runAutoAcceptJobRealWorkerOnce({
    nodeId: "policy-loop-worker",
    teamIds: [enabledTeam.id],
    batchSize: 1,
    leaseMs: 60_000,
    runBatch: async (input) => {
      runBatchCalls += 1;
      assert.equal(typeof input.canStartNewExternalAttempt, "function");
      policyAllowed = await input.canStartNewExternalAttempt?.({
        jobId: 1,
        teamId: enabledTeam.id,
        attemptKind: "non_pending_probe",
      }) ?? null;
      return emptySummary({ claimed: 1, retried: 1 });
    },
  });
  assert.equal(runBatchCalls, 1);
  assert.equal(policyAllowed, false);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.retried, 1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
