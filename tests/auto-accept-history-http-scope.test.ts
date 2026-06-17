process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-history-http-scope-test-key";
process.env.JWT_SECRET = "auto-accept-history-http-scope-jwt-secret";
process.env.COOKIE_SECRET = "auto-accept-history-http-scope-cookie-secret";

import assert from "node:assert/strict";
import { createServer } from "node:net";

type ApiBody<T = unknown> = {
  status: "success" | "error";
  data?: T;
  meta?: {
    total_items: number;
  };
};

function parseCookie(setCookie: string | null): string {
  assert.ok(setCookie, "login should set an auth cookie");
  return setCookie.split(";")[0] ?? "";
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected a TCP address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { createTeam } = await import("../src/repositories/team-repository.js");
  const { createUser } = await import("../src/repositories/user-repository.js");
  const { insertAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");
  const { startHttpServer, stopHttpServer } = await import("../src/services/http-server.js");

  resetMemoryDb();

  const alpha = await createTeam({ name: "Alpha Ops", enabled: true, spxCookie: "c1", spxDeviceId: "d1", lineGroupId: "g1" });
  const beta = await createTeam({ name: "Beta Ops", enabled: true, spxCookie: "c2", spxDeviceId: "d2", lineGroupId: "g2" });
  await createUser("alpha-user", "password-123456", "user", alpha.id);

  await insertAutoAcceptHistory(alpha.id, {
    ruleId: "alpha-rule",
    ruleName: "Alpha rule",
    bookingId: 2001,
    requestIds: [1001],
    acceptedCount: 1,
    origin: "Alpha Origin",
    destination: "Alpha Destination",
    vehicleType: "4W",
    status: "success",
  });
  await insertAutoAcceptHistory(beta.id, {
    ruleId: "beta-rule",
    ruleName: "Beta rule",
    bookingId: 2002,
    requestIds: [1002],
    acceptedCount: 1,
    origin: "Beta Origin",
    destination: "Beta Destination",
    vehicleType: "6W",
    status: "failed",
  });

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await startHttpServer(port);

  try {
    const blocked = await fetch(`${baseUrl}/api/auto-accept-history/paginated`);
    assert.equal(blocked.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alpha-user", password: "password-123456" }),
    });
    assert.equal(login.status, 200);
    const cookie = parseCookie(login.headers.get("set-cookie"));

    const scoped = await fetch(`${baseUrl}/api/auto-accept-history/paginated?teamId=${beta.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(scoped.status, 200);
    const body = await scoped.json() as ApiBody<Array<{ ruleName: string; teamId: number; teamName: string }>>;
    assert.equal(body.meta?.total_items, 1);
    assert.deepEqual((body.data ?? []).map((row) => row.ruleName), ["Alpha rule"]);
    assert.equal(body.data?.[0]?.teamId, alpha.id);
    assert.equal(body.data?.[0]?.teamName, "Alpha Ops");
  } finally {
    await stopHttpServer();
  }

  console.log("auto-accept-history-http-scope: all assertions passed");
}

main().catch(async (error) => {
  try {
    const { stopHttpServer } = await import("../src/services/http-server.js");
    await stopHttpServer();
  } catch {
    // ignore cleanup failures
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
