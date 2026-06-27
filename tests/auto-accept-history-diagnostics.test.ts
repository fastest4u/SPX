import assert from "node:assert/strict";

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-history-diagnostics-test-key";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const { LogLevel, setLogLevel } = await import("../src/utils/logger.js");
  const { insertAutoAcceptHistory, getAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");

  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);

  const verifiedAt = new Date("2026-06-27T07:30:00.000Z");

  await insertAutoAcceptHistory(1, {
    ruleId: "rule-diagnostics",
    ruleName: "Diagnostics Rule",
    bookingId: 2706815,
    requestIds: [38659805],
    acceptedCount: 0,
    origin: "NORC-B",
    destination: "SOCE",
    vehicleType: "6WH",
    status: "failed",
    errorMessage: "Other agency accepted first",
    failureReason: "lost_race",
    traceId: "aa:1:2706815:38659805:1782545400000",
    acceptRttMs: 84,
    listAgeMs: 231,
    verificationLatencyMs: 512,
    verificationStatus: "verified_failed",
    verifiedAt,
  });

  const rows = await getAutoAcceptHistory(1, { limit: 10 });
  const row = rows.find((item) => item.bookingId === 2706815);

  assert.ok(row, "diagnostic history row should be returned");
  assert.equal(row.failureReason, "lost_race");
  assert.equal(row.traceId, "aa:1:2706815:38659805:1782545400000");
  assert.equal(row.acceptRttMs, 84);
  assert.equal(row.listAgeMs, 231);
  assert.equal(row.verificationLatencyMs, 512);
  assert.equal(row.verificationStatus, "verified_failed");
  assert.equal(new Date(row.verifiedAt ?? "").toISOString(), verifiedAt.toISOString());

  await closePool();
  console.log("auto-accept-history-diagnostics: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
