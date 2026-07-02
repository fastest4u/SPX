import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { teamsController } from "../src/controllers/teams-controller.js";
import { setTeamRuntimeDesiredState, tryAcquireLease } from "../src/repositories/runtime-repository.js";
import { createTeam } from "../src/repositories/team-repository.js";

async function main(): Promise<void> {
  process.env.SECRETS_KEY = "teams-controller-runtime-status-test-key";
  await closePool();
  resetMemoryDb();

  const team = await createTeam({
    name: "PTWL",
    enabled: true,
    spxCookie: "cookie-ptwl",
    spxDeviceId: "device-ptwl",
    lineGroupId: "line-ptwl",
  });

  const lease = await tryAcquireLease({
    teamId: team.id,
    nodeId: "worker-ptwl",
    role: "worker",
    ttlMs: 30_000,
  });
  assert.equal(lease.acquired, true);

  const app = Fastify({ logger: false });
  try {
    await app.register(teamsController, { prefix: "/teams" });

    const runningResponse = await app.inject({ method: "GET", url: "/teams" });
    const runningBody = runningResponse.json();
    assert.equal(runningResponse.statusCode, 200);
    assert.equal(runningBody.status, "success");
    assert.equal(runningBody.data[0].runtimeStatus, "running");

    await setTeamRuntimeDesiredState({
      teamId: team.id,
      desiredState: "paused",
      reason: "pause requested from central API",
    });

    const pausedResponse = await app.inject({ method: "GET", url: "/teams" });
    const pausedBody = pausedResponse.json();
    assert.equal(pausedResponse.statusCode, 200);
    assert.equal(pausedBody.data[0].runtimeStatus, "paused");
  } finally {
    await app.close();
    await closePool();
  }
}

main().then(() => {
  console.log("teams-controller-runtime-status: distributed runtime status verified");
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
