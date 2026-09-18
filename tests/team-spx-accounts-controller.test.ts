process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "team-spx-accounts-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const {
    teamsController,
    currentTeamController,
  } = await import("../src/controllers/teams-controller.js");

  resetMemoryDb();

  const team1 = await createTeam({
    name: "Team PTWL",
    enabled: true,
    spxCookie: "fallback-cookie",
    spxDeviceId: "fallback-device",
    lineGroupId: "line-1",
  });

  const team2 = await createTeam({
    name: "Team IFN",
    enabled: true,
    spxCookie: "fallback-cookie-2",
    spxDeviceId: "fallback-device-2",
    lineGroupId: "line-2",
  });

  const app = Fastify({ logger: false });

  let authUser = {
    id: 1,
    username: "admin-user",
    role: "admin",
    teamId: undefined as number | undefined,
  };

  app.addHook("preHandler", async (req) => {
    req.user = authUser;
  });

  await app.register(teamsController, { prefix: "/teams" });
  await app.register(currentTeamController, { prefix: "/team" });

  // 1. GET /teams/:id/spx-accounts (admin)
  const getInitial = await app.inject({ method: "GET", url: `/teams/${team1.id}/spx-accounts` });
  assert.equal(getInitial.statusCode, 200);
  assert.deepEqual(getInitial.json().data, []);

  // 2. POST /teams/:id/spx-accounts (create Driver 1)
  const create1 = await app.inject({
    method: "POST",
    url: `/teams/${team1.id}/spx-accounts`,
    payload: {
      name: "Driver 1",
      spxCookie: "secret-cookie-1",
      spxDeviceId: "device-uuid-1",
      spxAppName: "App1",
      spxReferer: "https://spx.co.th",
      enabled: true,
    },
  });
  assert.equal(create1.statusCode, 201);
  const created1Body = create1.json().data;
  assert.equal(created1Body.name, "Driver 1");
  assert.equal(created1Body.email, "Driver 1");
  assert.equal(created1Body.hasPassword, false);
  assert.equal(created1Body.spxPassword, undefined);
  assert.equal(created1Body.hasSpxCookie, true);
  assert.equal(created1Body.hasSpxDeviceId, true);
  assert.equal(created1Body.teamId, team1.id);

  // 3. POST /teams/:id/spx-accounts (create Driver 2)
  const create2 = await app.inject({
    method: "POST",
    url: `/teams/${team1.id}/spx-accounts`,
    payload: {
      name: "Driver 2",
      spxCookie: "secret-cookie-2",
      spxDeviceId: "device-uuid-2",
      enabled: true,
    },
  });
  assert.equal(create2.statusCode, 201);
  const created2Body = create2.json().data;

  // 4. GET /teams/:id/spx-accounts returns both accounts with rate limit status
  const getBoth = await app.inject({ method: "GET", url: `/teams/${team1.id}/spx-accounts` });
  assert.equal(getBoth.statusCode, 200);
  const bothList = getBoth.json().data;
  assert.equal(bothList.length, 2);
  assert.equal(bothList[0].isRateLimited, false);
  assert.equal(bothList[0].isSessionExpired, false);

  // 5. PUT /teams/:id/spx-accounts/:accountId (update Driver 1)
  const update1 = await app.inject({
    method: "PUT",
    url: `/teams/${team1.id}/spx-accounts/${created1Body.id}`,
    payload: {
      name: "Driver 1 Updated",
      enabled: false,
    },
  });
  assert.equal(update1.statusCode, 200);
  assert.equal(update1.json().data.name, "Driver 1 Updated");
  assert.equal(update1.json().data.enabled, false);

  // 6. Reset rate limit endpoint
  const resetRateLimit = await app.inject({
    method: "POST",
    url: `/teams/${team1.id}/spx-accounts/${created1Body.id}/reset-rate-limit`,
  });
  assert.equal(resetRateLimit.statusCode, 200);

  // 7. DELETE /teams/:id/spx-accounts/:accountId (delete Driver 2)
  const delete2 = await app.inject({
    method: "DELETE",
    url: `/teams/${team1.id}/spx-accounts/${created2Body.id}`,
  });
  assert.equal(delete2.statusCode, 200);

  const getRemaining = await app.inject({ method: "GET", url: `/teams/${team1.id}/spx-accounts` });
  assert.equal(getRemaining.json().data.length, 1);

  // 8. Test team user accessing /team/spx-accounts
  authUser = {
    id: 10,
    username: "ptwl-driver",
    role: "user",
    teamId: team1.id,
  };

  const ownList = await app.inject({ method: "GET", url: "/team/spx-accounts" });
  assert.equal(ownList.statusCode, 200);
  assert.equal(ownList.json().data.length, 1);
  assert.equal(ownList.json().data[0].id, created1Body.id);

  // Create via /team/spx-accounts
  const ownCreate = await app.inject({
    method: "POST",
    url: "/team/spx-accounts",
    payload: {
      name: "Driver 3 from Team UI",
      spxCookie: "team-cookie-3",
      spxDeviceId: "team-device-3",
      enabled: true,
    },
  });
  assert.equal(ownCreate.statusCode, 201);

  const ownListAfter = await app.inject({ method: "GET", url: "/team/spx-accounts" });
  assert.equal(ownListAfter.json().data.length, 2);

  // Verify Team 2 accounts are strictly isolated:
  const team2List = await app.inject({ method: "GET", url: `/teams/${team2.id}/spx-accounts` });
  assert.equal(team2List.json().data.length, 0);

  // Verify validation error when creating without password and without cookie:
  const invalidCreate = await app.inject({
    method: "POST",
    url: "/team/spx-accounts",
    payload: {
      email: "driver4@gmail.com",
    },
  });
  assert.equal(invalidCreate.statusCode, 400);
  assert.equal(invalidCreate.json().error_code, "VALIDATION_ERROR");

  console.log("team-spx-accounts-controller: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
