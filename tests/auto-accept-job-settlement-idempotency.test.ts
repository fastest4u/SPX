import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import {
  getAutoAcceptHistory,
  insertAutoAcceptHistoryAndGetId,
  type AutoAcceptRecord,
} from "../src/repositories/auto-accept-repository.js";
import {
  hasAutoAcceptRuleBudgetReservation,
  getAutoAcceptBudgetReservationSummary,
  releaseAutoAcceptRuleBudgetOnce,
  reserveAutoAcceptRuleBudgetOnce,
} from "../src/repositories/auto-accept-job-settlement-repository.js";
import { createAutoAcceptJobSettlementOperations } from "../src/services/auto-accept-job-settlement.js";
import { applyAutoAcceptProgress, createRule, readRules } from "../src/services/notify-rules.js";

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

function historyRecord(ruleId: string): AutoAcceptRecord {
  return {
    ruleId,
    ruleName: "Bangkok to Rayong",
    bookingId: 2791810,
    requestIds: [40288114],
    acceptedCount: 1,
    origin: "Bangkok",
    destination: "Rayong",
    vehicleType: "4W",
    status: "success",
    traceId: "aa:2:2791810:40288114:2030",
    listAgeMs: 1200,
    verificationStatus: "verified_success",
    verifiedAt: new Date("2030-01-01T00:02:00.000Z"),
  };
}

async function main() {
  await resetDb();

  const rule = await createRule(2, {
    name: "Bangkok to Rayong",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const operations = createAutoAcceptJobSettlementOperations({
    publisher: {
      publish: async () => ({ ok: true }),
      autoAcceptOwned: async () => ({ ok: true }),
    },
  });

  const progressInput = {
    jobId: 9001,
    teamId: 2,
    bookingId: 2791810,
    requestIds: [40288114],
    ruleId: rule.id,
    acceptedCount: 1,
    traceId: "aa:2:2791810:40288114:2030",
    reasonCode: "verified_owned",
  };
  await operations.settleProgress(progressInput);
  await operations.settleProgress(progressInput);

  const [updatedRule] = (await readRules(2)).filter((item) => item.id === rule.id);
  assert.ok(updatedRule);
  assert.equal(updatedRule.need, 1, "progress settlement should decrement a job only once");
  assert.equal(updatedRule.fulfilled, false);
  assert.equal(updatedRule.auto_accepted, false);

  const historyInput = {
    jobId: 9001,
    teamId: 2,
    record: historyRecord(rule.id),
  };
  await operations.writeHistory(historyInput);
  await operations.writeHistory(historyInput);

  const history = await getAutoAcceptHistory(2, { limit: 20, sortBy: "id", sortDir: "asc" });
  assert.equal(history.length, 1, "history settlement should insert one row for a job");
  assert.equal(history[0].bookingId, 2791810);
  assert.deepEqual(history[0].requestIds, [40288114]);

  const duplicateInput = { ...progressInput, jobId: 9002 };
  assert.equal((await reserveAutoAcceptRuleBudgetOnce(duplicateInput)).reserved, true);
  await operations.settleProgress(duplicateInput);
  await operations.writeHistory({ ...historyInput, jobId: 9002 });
  assert.equal((await readRules(2)).find((item) => item.id === rule.id)?.need, 1,
    "another attempt kind or epoch for the same accepted request must not decrement need again");
  assert.equal((await getAutoAcceptHistory(2, { limit: 20 })).length, 1,
    "canonical result recovery through another job must reuse the same history row");
  const reservations = await getAutoAcceptBudgetReservationSummary({ now: new Date(), staleTtlMs: 60000 });
  assert.equal(reservations.activeCount, 0, "duplicate settlement must terminalize its own job reservation");

  const differentRule = await createRule(2, {
    name: "Second matching rule", origins: ["Bangkok"], destinations: ["Rayong"], vehicle_types: ["4W"],
    need: 2, enabled: true, fulfilled: false, auto_accepted: false,
  });
  await operations.settleProgress({ ...progressInput, jobId: 9003, ruleId: differentRule.id });
  assert.equal((await readRules(2)).find((item) => item.id === differentRule.id)?.need, 2,
    "a single accepted request cannot count toward a second rule");

  await operations.settleProgress({ ...progressInput, jobId: 9004, requestIds: [40288115] });
  assert.equal((await readRules(2)).find((item) => item.id === rule.id)?.need, 0,
    "a different accepted request must still count");

  await resetDb();
  const budgetRule = await createRule(2, {
    name: "Reserved route",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const reservation = {
    jobId: 9101,
    teamId: 2,
    bookingId: 2791821,
    requestIds: [40288121],
    ruleId: budgetRule.id,
    acceptedCount: 1,
    reasonCode: "real_execution_budget_reservation",
  };
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce(reservation), { reserved: true, duplicate: false });
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce(reservation), { reserved: true, duplicate: true });
  assert.equal(await hasAutoAcceptRuleBudgetReservation(9101), true);
  assert.equal((await readRules(2)).find((item) => item.id === budgetRule.id)?.need, 1);
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce({
    ...reservation,
    jobId: 9102,
    bookingId: 2791822,
    requestIds: [40288122],
  }), { reserved: false, duplicate: false, reasonCode: "rule_budget_exhausted" });

  await operations.settleProgress({
    jobId: 9101,
    teamId: 2,
    bookingId: 2791821,
    requestIds: [40288121],
    ruleId: budgetRule.id,
    acceptedCount: 1,
    traceId: "aa:reserved",
    reasonCode: "verified_owned",
  });
  assert.equal((await readRules(2)).find((item) => item.id === budgetRule.id)?.need, 0);
  assert.deepEqual(await releaseAutoAcceptRuleBudgetOnce(reservation), { released: false, duplicate: false });
  assert.equal((await readRules(2)).find((item) => item.id === budgetRule.id)?.need, 0);

  await resetDb();
  const releaseRule = await createRule(2, {
    name: "Released route",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const releasable = {
    ...reservation,
    jobId: 9201,
    ruleId: releaseRule.id,
  };
  const afterReleaseCandidate = {
    ...reservation,
    jobId: 9202,
    bookingId: 2791822,
    requestIds: [40288122],
    ruleId: releaseRule.id,
  };
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce(releasable), { reserved: true, duplicate: false });
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce(afterReleaseCandidate), { reserved: false, duplicate: false, reasonCode: "rule_budget_exhausted" });
  assert.deepEqual(await releaseAutoAcceptRuleBudgetOnce(releasable), { released: true, duplicate: false });
  assert.deepEqual(await releaseAutoAcceptRuleBudgetOnce(releasable), { released: true, duplicate: true });
  assert.equal((await readRules(2)).find((item) => item.id === releaseRule.id)?.need, 1);
  assert.deepEqual(await reserveAutoAcceptRuleBudgetOnce(afterReleaseCandidate), { reserved: true, duplicate: false });

  await resetDb();
  const identityRule = await createRule(2, {
    name: "Canonical identity guard",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  getRawMemoryDb().prepare(`
    INSERT INTO auto_accept_job_settlements (
      settlement_key, job_id, team_id, booking_id, request_id, rule_id,
      settlement_step, side_effect_id, metadata_json, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "auto_accept_request:2:2791830:40288130:progress",
    9300,
    3,
    9999999,
    99999999,
    identityRule.id,
    "progress_claim",
    null,
    "{}",
    "2030-01-01 00:00:00",
    "2030-01-01 00:00:00",
  );
  await assert.rejects(
    operations.settleProgress({
      jobId: 9301,
      teamId: 2,
      bookingId: 2791830,
      requestIds: [40288130],
      ruleId: identityRule.id,
      acceptedCount: 1,
      reasonCode: "verified_owned",
    }),
    /canonical settlement identity conflicts with another request/,
    "a canonical key collision with mismatched stored identity must fail closed",
  );

  await resetDb();
  const jobIdentityRule = await createRule(2, {
    name: "Per-job identity guard",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const db = getRawMemoryDb();
  const insertForgedSettlement = (key: string, jobId: number, step: "progress" | "history") => db.prepare(`
    INSERT INTO auto_accept_job_settlements (
      settlement_key, job_id, team_id, booking_id, request_id, rule_id,
      settlement_step, side_effect_id, metadata_json, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    jobId,
    3,
    9999999,
    99999999,
    jobIdentityRule.id,
    step,
    null,
    "{}",
    "2030-01-01 00:00:00",
    "2030-01-01 00:00:00",
  );
  insertForgedSettlement("auto_accept_job:9401:progress", 9401, "progress");
  await assert.rejects(
    operations.settleProgress({
      jobId: 9401,
      teamId: 2,
      bookingId: 2791840,
      requestIds: [40288140],
      ruleId: jobIdentityRule.id,
      acceptedCount: 1,
      reasonCode: "verified_owned",
    }),
    /job settlement identity conflicts with another request/,
    "a per-job progress key collision with mismatched stored identity must fail closed",
  );
  insertForgedSettlement("auto_accept_job:9501:history", 9501, "history");
  await assert.rejects(
    operations.writeHistory({
      jobId: 9501,
      teamId: 2,
      record: {
        ...historyRecord(jobIdentityRule.id),
        bookingId: 2791850,
        requestIds: [40288150],
      },
    }),
    /job settlement identity conflicts with another request/,
    "a per-job history key collision with mismatched stored identity must fail closed",
  );

  await resetDb();
  const verificationRule = await createRule(2, {
    name: "History verification guard",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  await assert.rejects(
    operations.writeHistory({
      jobId: 9601,
      teamId: 2,
      record: {
        ...historyRecord(verificationRule.id),
        verificationStatus: "indeterminate",
      },
    }),
    /successful history settlement requires verified success/,
    "a success history cannot become canonical without verified-success evidence",
  );

  await resetDb();
  const legacyRule = await createRule(2, {
    name: "Legacy settlement adoption",
    origins: ["Bangkok"],
    destinations: ["Rayong"],
    vehicle_types: ["4W"],
    need: 2,
    enabled: true,
    fulfilled: false,
    auto_accepted: false,
  });
  const legacyRecord = {
    ...historyRecord(legacyRule.id),
    bookingId: 2791870,
    requestIds: [40288170],
  };
  const legacyHistoryId = await insertAutoAcceptHistoryAndGetId(2, legacyRecord);
  assert.ok(legacyHistoryId && legacyHistoryId > 0);
  await applyAutoAcceptProgress(2, [{ ruleId: legacyRule.id, acceptedCount: 1 }]);
  const insertLegacySettlement = (
    key: string,
    jobId: number,
    step: "progress" | "history",
    sideEffectId: number | null,
  ) => getRawMemoryDb().prepare(`
    INSERT INTO auto_accept_job_settlements (
      settlement_key, job_id, team_id, booking_id, request_id, rule_id,
      settlement_step, side_effect_id, metadata_json, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    jobId,
    2,
    legacyRecord.bookingId,
    legacyRecord.requestIds[0],
    legacyRule.id,
    step,
    sideEffectId,
    "{}",
    "2030-01-01 00:00:00",
    "2030-01-01 00:00:00",
  );
  insertLegacySettlement("auto_accept_job:9701:progress", 9701, "progress", null);
  insertLegacySettlement("auto_accept_job:9701:history", 9701, "history", legacyHistoryId);
  await operations.settleProgress({
    jobId: 9702,
    teamId: 2,
    bookingId: legacyRecord.bookingId,
    requestIds: legacyRecord.requestIds,
    ruleId: legacyRule.id,
    acceptedCount: 1,
    reasonCode: "verified_owned",
  });
  await operations.writeHistory({ jobId: 9702, teamId: 2, record: legacyRecord });
  assert.equal((await readRules(2)).find((item) => item.id === legacyRule.id)?.need, 1,
    "a legacy progress marker must be adopted without decrementing the rule again");
  assert.equal((await getAutoAcceptHistory(2, { limit: 20 })).length, 1,
    "a legacy verified-success history marker must be adopted without another history row");

  await assert.rejects(
    operations.settleProgress({
      jobId: 9801,
      teamId: 2,
      bookingId: 2791880,
      requestIds: [40288180, 40288181],
      ruleId: legacyRule.id,
      acceptedCount: 2,
      reasonCode: "verified_owned",
    }),
    /exactly one accepted request/,
  );
  await assert.rejects(
    operations.writeHistory({
      jobId: 9802,
      teamId: 2,
      record: {
        ...historyRecord(legacyRule.id),
        bookingId: 2791880,
        requestIds: [40288180, 40288181],
        acceptedCount: 2,
      },
    }),
    /exactly one request/,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
