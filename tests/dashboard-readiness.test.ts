// Must set DB_MODE before any imports because ESM evaluates all imports
// before top-level code. env.ts reads process.env.DB_MODE at module load
// time; if imported first, it sees "mysql" (default) instead of "memory".
process.env.DB_MODE = "memory";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  console.log("[DEBUG] process.env.DB_MODE at start of main:", process.env.DB_MODE);
  const { env } = await import("../src/config/env.js");
  console.log("[DEBUG] env.DB_MODE from env.ts:", env.DB_MODE);
  const Fastify = (await import("fastify")).default;
  const { dashboardController } = await import("../src/controllers/dashboard-controller.js");
  const { closePool } = await import("../src/db/client.js");
  const { metrics } = await import("../src/services/metrics.js");

  const app = Fastify({ logger: false });

  try {
    await app.register(dashboardController);

    for (let i = 0; i < 5; i++) {
      metrics.recordPoll(10, false, "session-error", null);
    }

    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    const healthBody = healthResponse.json();

    assert.equal(healthResponse.statusCode, 503);
    assert.equal(healthBody.data.status, "degraded");
    assert.equal(healthBody.data.session.healthy, false);

    const readyResponse = await app.inject({ method: "GET", url: "/ready" });
    const readyBody = readyResponse.json();

    console.log("[DEBUG] /ready status:", readyResponse.statusCode);
    console.log("[DEBUG] /ready body:", JSON.stringify(readyBody));
    assert.equal(readyResponse.statusCode, 200);
    assert.equal(readyBody.data.ready, true);
  } finally {
    await app.close();
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
