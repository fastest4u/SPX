import assert from "node:assert/strict";
import Fastify from "fastify";

process.env.SPX_TEST_SKIP_ENV_FILE = "1";
process.env.NODE_ENV = "test";
process.env.DB_MODE = "memory";
async function run() {
const { resetMemoryDb } = await import("../src/db/client-memory.js");
const { createTeam } = await import("../src/repositories/team-repository.js");
const { insertAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");
const { autoAcceptHistoryController } = await import("../src/controllers/auto-accept-history-controller.js");
resetMemoryDb();
const own = await createTeam({ name: "Own", enabled: true });
const other = await createTeam({ name: "Other", enabled: true });
for (const team of [own, other]) for (const status of ["success", "failed", "indeterminate"] as const) {
  await insertAutoAcceptHistory(team.id, { ruleId: status, ruleName: status, bookingId: 123, requestIds: [], acceptedCount: 0, origin: "A", destination: "B", vehicleType: "6WH", status });
}
const app = Fastify();
app.addHook("preHandler", async (req) => { Object.assign(req, { user: { id: 1, username: "own", role: "user", teamId: own.id } }); });
await app.register(autoAcceptHistoryController, { prefix: "/history" });
try {
  for (const path of ["/history/", "/history/paginated"]) for (const status of ["indeterminate", "success", "failed"]) {
    const response = await app.inject(`${path}?status=${status}`);
    assert.equal(response.statusCode, 200, `${path} must accept ${status}: ${response.body}`);
    const rows = response.json().data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, status);
    assert.equal(rows[0].teamId, own.id);
  }
} finally { await app.close(); }
console.log("own-team history status HTTP filters passed");
}
run().catch((error) => { console.error(error); process.exit(1); });
