process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "current-team-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam, getTeamById } = await import("../src/repositories/team-repository.js");
  const { currentTeamController, setTeamRuntimeActions } = await import("../src/controllers/teams-controller.js");

  resetMemoryDb();

  const team = await createTeam({
    name: "PTWL",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "line",
  });
  const runtimeStatuses = new Map<number, string>([[team.id, "running"]]);
  const runtimeActions: string[] = [];

  setTeamRuntimeActions({
    stopTeam: async (teamId) => {
      runtimeActions.push(`stop:${teamId}`);
      runtimeStatuses.set(teamId, "stopped");
    },
    restartTeam: async (teamId) => {
      runtimeActions.push(`restart:${teamId}`);
      runtimeStatuses.set(teamId, "running");
    },
    getStatus: (teamId) => {
      const status = runtimeStatuses.get(teamId);
      return status ? { status } : null;
    },
  });

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    req.user = {
      id: 10,
      username: "team-user",
      role: "user",
      teamId: team.id,
    };
  });

  try {
    await app.register(currentTeamController, { prefix: "/team" });

    const currentResponse = await app.inject({ method: "GET", url: "/team" });
    const currentBody = currentResponse.json();
    assert.equal(currentResponse.statusCode, 200);
    assert.equal(currentBody.data.id, team.id);
    assert.equal(currentBody.data.enabled, true);
    assert.equal(currentBody.data.runtimeStatus, "running");

    const disableResponse = await app.inject({
      method: "PUT",
      url: "/team/enabled",
      payload: { enabled: false },
    });
    const disableBody = disableResponse.json();
    assert.equal(disableResponse.statusCode, 200);
    assert.equal(disableBody.data.id, team.id);
    assert.equal(disableBody.data.enabled, false);
    assert.equal(disableBody.data.runtimeStatus, "stopped");
    assert.equal((await getTeamById(team.id))?.enabled, false);

    const enableResponse = await app.inject({
      method: "PUT",
      url: "/team/enabled",
      payload: { enabled: true },
    });
    const enableBody = enableResponse.json();
    assert.equal(enableResponse.statusCode, 200);
    assert.equal(enableBody.data.id, team.id);
    assert.equal(enableBody.data.enabled, true);
    assert.equal(enableBody.data.runtimeStatus, "running");
    assert.equal((await getTeamById(team.id))?.enabled, true);

    assert.deepEqual(runtimeActions, [`stop:${team.id}`, `restart:${team.id}`]);
  } finally {
    setTeamRuntimeActions({});
    await app.close();
  }

  console.log("current-team-controller: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
