import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import type { AutoAcceptVerificationJob, AutoAcceptVerificationOutcome } from "../src/services/auto-accept-verifier.js";
import { autoAcceptVerificationJobsMigrationSql } from "../src/db/migration-sql.js";
import { saveBookingRequests } from "../src/services/db-service.js";
import type { ExtractedTripInfo } from "../src/utils/booking-extractor.js";

async function main() {
const repositoryPath = "src/repositories/auto-accept-verification-repository.ts";
assert.equal(existsSync(repositoryPath), true, "durable verification repository must exist before accepts can survive restart");
const repo = await import("../src/repositories/auto-accept-verification-repository.js");
const db = getRawMemoryDb();
const job = (teamId = 1, traceId = "trace-1", requestIds = [101, 102]): AutoAcceptVerificationJob => ({
  teamId, traceId, requestIds, ruleId: "rule-1", ruleName: "test", bookingId: 100,
  trips: requestIds.map(request_id => ({ request_id, origin: "A", destination: "B" })),
  claimToken: 1, acceptResult: { ok: false, httpStatus: 0 }, acceptStartedAt: 1,
  acceptFinishedAt: 1, acceptRttMs: 0, ambiguousAccept: true, acceptAll: false,
});
const outcome = (j: AutoAcceptVerificationJob, accepted: number[], failed: number[] = []): AutoAcceptVerificationOutcome => ({
  job: j, verificationStatus: "indeterminate", acceptedRequestIds: accepted,
  failedRequestIds: failed, indeterminateRequestIds: j.requestIds.filter(id => !accepted.includes(id) && !failed.includes(id)),
  requests: j.requestIds.map(requestId => ({ requestId,
    status: accepted.includes(requestId) ? "accepted" : failed.includes(requestId) ? "failed" : "indeterminate",
    reason: accepted.includes(requestId) ? undefined : failed.includes(requestId) ? "lost_race" : "verify_indeterminate",
    observedStatus: accepted.includes(requestId) ? 2 : failed.includes(requestId) ? 4 : null,
    terminal: accepted.includes(requestId) || failed.includes(requestId), releaseRequestDedupe: false, releaseBudget: failed.includes(requestId),
  })),
  evidence: { traceId: j.traceId, verificationStatus: "indeterminate", pendingTabRead: true, confirmedTabRead: false, observedStatuses: {}, nextAction: "retry" },
});

db.prepare("INSERT INTO notify_rules (id,team_id,name,need,auto_accept) VALUES ('rule-1',1,'test',2,1)").run();
const created = await repo.createAutoAcceptVerificationIntent(job(), { now: 1000, postRecoveryDelayMs: 120000 });
assert.equal(created.created, true);
assert.equal((db.prepare("SELECT count(*) AS n FROM auto_accept_history WHERE status='indeterminate'").get() as {n:number}).n, 2, "intent records unresolved history once");
assert.equal((await repo.createAutoAcceptVerificationIntent(job(), { now: 1000 })).created, false);
assert.equal((await repo.listAutoAcceptVerificationHolds(1)).length, 1);
assert.equal((await repo.listAutoAcceptVerificationHolds(2)).length, 0);
db.prepare("UPDATE auto_accept_history SET error_message='Pending verification' WHERE trace_id='trace-1'").run();
assert.equal(await repo.claimAutoAcceptVerificationJob(1, "trace-1", { now: 2000 }), null, "do not race the in-flight POST");
assert.equal(await repo.updateAutoAcceptVerificationResponse({ ...job(), acceptResult: { ok: true, httpStatus: 200 } }, { now: 2000 }), true);
const firstLease = await repo.claimAutoAcceptVerificationJob(1, "trace-1", { now: 2000, leaseMs: 1000 });
assert.ok(firstLease?.leaseToken);
assert.equal(await repo.claimAutoAcceptVerificationJob(2, "trace-1", { now: 4000 }), null);
const recovered = await repo.claimAutoAcceptVerificationJob(1, "trace-1", { now: 4000, leaseMs: 1000 });
assert.ok(recovered?.leaseToken);
assert.notEqual(recovered.leaseToken, firstLease.leaseToken);
await assert.rejects(repo.settleAutoAcceptVerificationJob(1,"trace-1",recovered.leaseToken,outcome({...job(),requestIds:[101,102,999]},[999]),{now:4100}), /outside the durable job/, "ordinary request-id accepts cannot discover unrelated IDs");
await assert.rejects(repo.settleAutoAcceptVerificationJob(1,"trace-1",recovered.leaseToken,outcome({...job(),trips:[{request_id:101,booking_id:999}]},[101]),{now:4100}), /trip booking identity/, "contradictory booking metadata must not settle");
assert.equal((await repo.settleAutoAcceptVerificationJob(1, "trace-1", firstLease.leaseToken, outcome(job(), [101]), { now: 4100 })).applied, false);
const partial = await repo.settleAutoAcceptVerificationJob(1, "trace-1", recovered.leaseToken, outcome(job(), [101]), { now: 4100, nextAttemptAt: 5000 });
assert.equal(partial.applied, true);
assert.deepEqual(partial.newlyAcceptedRequestIds, [101]);
assert.deepEqual(partial.record?.unresolvedRequestIds, [102]);
assert.equal((db.prepare("SELECT need FROM notify_rules WHERE id='rule-1'").get() as { need:number }).need, 1);
assert.equal((await repo.settleAutoAcceptVerificationJob(1, "trace-1", recovered.leaseToken, outcome(job(), [101]), { now: 4101 })).applied, false);
const lease2 = await repo.claimAutoAcceptVerificationJob(1, "trace-1", { now: 5000, leaseMs: 1000 });
assert.ok(lease2?.leaseToken);
const final = await repo.settleAutoAcceptVerificationJob(1, "trace-1", lease2.leaseToken, outcome(job(), [101], [102]), { now: 5100 });
assert.deepEqual(final.newlyAcceptedRequestIds, []);
assert.deepEqual(final.newlyFailedRequestIds, [102]);
assert.equal((db.prepare("SELECT error_message FROM auto_accept_history WHERE trace_id='trace-1' AND request_ids='[101]'").get() as {error_message:string|null}).error_message,null);
assert.equal((db.prepare("SELECT error_message FROM auto_accept_history WHERE trace_id='trace-1' AND request_ids='[102]'").get() as {error_message:string|null}).error_message,"Verification failed: lost_race");
const canonicalLost = db.prepare("SELECT reason_code,evidence_json FROM auto_accept_results WHERE team_id=1 AND request_id=102").get() as {reason_code:string;evidence_json:string};
assert.equal(canonicalLost.reason_code,"verified_lost_race","canonical reason codes remain compatible with existing diagnostics");
assert.equal(JSON.parse(canonicalLost.evidence_json).source,"detached_verification");
assert.equal((await repo.listAutoAcceptVerificationHolds(1)).length, 0);
assert.equal((db.prepare("SELECT need FROM notify_rules WHERE id='rule-1'").get() as { need:number }).need, 1);
assert.equal((db.prepare("SELECT count(*) AS n FROM auto_accept_history").get() as {n:number}).n, 2);
assert.equal(final.record?.notifications.length, 2);
for (const notification of final.record!.notifications) await repo.acknowledgeAutoAcceptVerificationNotification(1, "trace-1", notification.id);
assert.equal((await repo.listAutoAcceptVerificationJobs(1)).length, 0);

// A new trace for an already owned request cannot downgrade ownership or consume quota twice.
await repo.createAutoAcceptVerificationIntent(job(1, "trace-2", [101]), { now: 6000, postRecoveryDelayMs: 0 });
const duplicateLease = await repo.claimAutoAcceptVerificationJob(1, "trace-2", { now: 6000 });
assert.ok(duplicateLease?.leaseToken);
await repo.settleAutoAcceptVerificationJob(1, "trace-2", duplicateLease.leaseToken, outcome(job(1, "trace-2", [101]), [], [101]), { now: 6001 });
assert.equal((db.prepare("SELECT status FROM auto_accept_results WHERE request_id=101").get() as {status:string}).status, "owned");
assert.equal((db.prepare("SELECT need FROM notify_rules WHERE id='rule-1'").get() as {need:number}).need, 1);

// Failure after canonical insert must roll back result, history, rule, and queue together.
await repo.createAutoAcceptVerificationIntent(job(2, "rollback", [201]), { now: 7000, postRecoveryDelayMs: 0 });
const rollbackLease = await repo.claimAutoAcceptVerificationJob(2, "rollback", { now: 7000 });
assert.ok(rollbackLease?.leaseToken);
db.exec("CREATE TRIGGER fail_history BEFORE UPDATE ON auto_accept_history BEGIN SELECT RAISE(ABORT, 'injected history failure'); END");
await assert.rejects(repo.settleAutoAcceptVerificationJob(2, "rollback", rollbackLease.leaseToken, outcome(job(2, "rollback", [201]), [201]), { now: 7001 }), /injected history failure/);
assert.equal(db.prepare("SELECT * FROM auto_accept_results WHERE request_id=201").get(), undefined);
assert.deepEqual((await repo.listAutoAcceptVerificationHolds(2))[0]?.unresolvedRequestIds, [201]);
db.exec("DROP TRIGGER fail_history");
await repo.settleAutoAcceptVerificationJob(2, "rollback", rollbackLease.leaseToken, outcome(job(2, "rollback", [201]), [201]), { now: 7001 });
assert.deepEqual(db.prepare("SELECT need,fulfilled,auto_accepted FROM notify_rules WHERE id='rule-1'").get(), {need:0,fulfilled:1,auto_accepted:1}, "global rule ownership fallback matches existing progress");

const discoveryJob = { ...job(1, "discovery", []), acceptAll: true, reservationCount: 7, discovery:{bookingName:"A-B",expectedAcceptedCount:3,verifiedRequestIds:[]} };
await repo.createAutoAcceptVerificationIntent(discoveryJob, { now: 8000, postRecoveryDelayMs: 0 });
assert.equal((db.prepare("SELECT request_ids FROM auto_accept_history WHERE trace_id='discovery' AND status='indeterminate'").get() as {request_ids:string})?.request_ids, "[]", "accept-all is visible while waiting for discovered request IDs");
const discoveryLease = await repo.claimAutoAcceptVerificationJob(1, "discovery", { now: 8000 });
assert.ok(discoveryLease?.leaseToken);
assert.equal(discoveryLease.job.reservationCount,7,"restart restores the full quota reserved before accept-all discovery");
await repo.settleAutoAcceptVerificationJob(1, "discovery", discoveryLease.leaseToken, { ...outcome(discoveryJob, []), discoveryPending: true }, { now: 8001 });
assert.equal((await repo.listAutoAcceptVerificationHolds(1)).length, 1, "empty accept-all discovery remains held");
const discoveredLease = await repo.claimAutoAcceptVerificationJob(1, "discovery", { now: 40000 });
assert.ok(discoveredLease?.leaseToken);
const discoveredJob = {...discoveryJob, requestIds:[801], trips:[{request_id:801}],discovery:{...discoveryJob.discovery,verifiedRequestIds:[801]}};
await repo.settleAutoAcceptVerificationJob(1, "discovery", discoveredLease.leaseToken, {...outcome(discoveredJob,[801]), discoveryPending:true}, {now:40001});
assert.deepEqual(db.prepare("SELECT request_ids,status FROM auto_accept_history WHERE trace_id='discovery' ORDER BY id").all(), [{request_ids:"[801]",status:"success"},{request_ids:"[]",status:"indeterminate"}], "partly discovered acceptance keeps a visible aggregate wait");
assert.deepEqual((await repo.listAutoAcceptVerificationJobs(1)).find(row=>row.job.traceId==="discovery")?.job.discovery?.verifiedRequestIds,[801],"discovery remembers ownership proven on earlier polls");
const finalDiscoveryLease = await repo.claimAutoAcceptVerificationJob(1,"discovery",{now:71000});
assert.ok(finalDiscoveryLease?.leaseToken);
const allDiscoveredJob = {...discoveredJob,requestIds:[801,802,803],trips:[{request_id:801},{request_id:802},{request_id:803}],discovery:{...discoveredJob.discovery,verifiedRequestIds:[801,802,803]}};
await repo.settleAutoAcceptVerificationJob(1,"discovery",finalDiscoveryLease.leaseToken,{...outcome(allDiscoveredJob,[801,802,803]),discoveryPending:false},{now:71001});
assert.deepEqual(db.prepare("SELECT request_ids,status FROM auto_accept_history WHERE trace_id='discovery' ORDER BY id").all(),[{request_ids:"[801]",status:"success"},{request_ids:"[802]",status:"success"},{request_ids:"[803]",status:"success"}],"complete discovery closes its placeholder without duplicating an earlier success");
const rejectedDiscovery = {...discoveryJob,traceId:"discovery-rejected",ambiguousAccept:false,acceptResult:{ok:false,httpStatus:401}};
await repo.createAutoAcceptVerificationIntent(rejectedDiscovery,{now:50000});
await repo.updateAutoAcceptVerificationResponse(rejectedDiscovery,{now:50000});
const rejectedLease = await repo.claimAutoAcceptVerificationJob(1,"discovery-rejected",{now:50000});
assert.ok(rejectedLease?.leaseToken);
const rejection = await repo.settleAutoAcceptVerificationJob(1,"discovery-rejected",rejectedLease.leaseToken,{...outcome(rejectedDiscovery,[]),discoveryPending:false,discoveryFailureReason:"session_expired"},{now:50001});
assert.equal(rejection.applied,true);
assert.deepEqual(db.prepare("SELECT status,failure_reason,request_ids FROM auto_accept_history WHERE trace_id='discovery-rejected'").get(),{status:"failed",failure_reason:"session_expired",request_ids:"[]"},"definite HTTP rejection closes the aggregate discovery history without inventing request IDs");
assert.equal((await repo.listAutoAcceptVerificationHolds(1)).some(row=>row.job.traceId==="discovery-rejected"),false);

assert.equal(typeof repo.importHistoricalAutoAcceptVerifications, "function", "historical indeterminate attempts need durable read-only import");
db.prepare("INSERT INTO auto_accept_history (team_id,rule_id,rule_name,booking_id,request_ids,status,failure_reason,trace_id) VALUES (2,'rule-1','test',300,'[301,302]','indeterminate','verify_indeterminate','old-trace')").run();
assert.equal(await repo.importHistoricalAutoAcceptVerifications(2, { now: 9000 }), 1);
assert.equal(await repo.importHistoricalAutoAcceptVerifications(2, { now: 9001 }), 0);
const historical = (await repo.listAutoAcceptVerificationHolds(2)).find(row => row.job.traceId === "old-trace");
assert.deepEqual(historical?.unresolvedRequestIds, [301,302]);
assert.equal(historical?.job.ambiguousAccept, true);
assert.equal((db.prepare("SELECT count(*) AS n FROM auto_accept_history WHERE trace_id='old-trace'").get() as {n:number}).n, 2, "split historical batch without duplicate pending history");

for (let index = 0; index < 505; index++) await repo.createAutoAcceptVerificationIntent(job(3, `hold-${index}`, [1000 + index]), { now: 10000 });
assert.equal((await repo.listAutoAcceptVerificationHolds(3)).length, 505, "restart must restore holds beyond the historical 500-row cap");
const secretJob = { ...job(3, "sanitize", [2000]), acceptResult: { ok:false, httpStatus:0, error:"synthetic-secret", message:"synthetic-secret" }, trips: [{ request_id:2000, origin:"A", cookie:"synthetic-secret" }] };
await repo.createAutoAcceptVerificationIntent(secretJob);
assert.equal(String((db.prepare("SELECT job_json FROM auto_accept_verification_jobs WHERE trace_id='sanitize'").get() as {job_json:string}).job_json).includes("synthetic-secret"), false);
const extractedTrip: ExtractedTripInfo = { request_id:2100, booking_id:100, booking_name:"A-B", agency_name:"agency", เส้นทาง:"A -> B", ประเภทการจ่าย:"per-trip", รูปแบบของทริป:"single", ประเภทการเดินทาง:"day", ประเภทรถ:"truck", vehicle_type_id:3, ต้นทาง:"A", ปลายทาง:"B", วันที่เวลาสแตนบาย:"2030-01-01 10:00", acceptance_status:2, assignment_status:1 };
const extractedJob = {...job(3,"trip-metadata",[2100]),trips:[extractedTrip]};
await repo.createAutoAcceptVerificationIntent(extractedJob,{now:20000,postRecoveryDelayMs:0});
const metadataLease = await repo.claimAutoAcceptVerificationJob(3,"trip-metadata",{now:20000});
assert.ok(metadataLease?.leaseToken);
assert.deepEqual(metadataLease.job.trips[0],extractedTrip,"durable recovery preserves every extracted business field");
const metadataSettlement = await repo.settleAutoAcceptVerificationJob(3,"trip-metadata",metadataLease.leaseToken,outcome(metadataLease.job,[2100]),{now:20001});
const restoredTrips = metadataSettlement.record!.notifications[0].outcome.job.trips as ExtractedTripInfo[];
assert.equal((await saveBookingRequests(3,restoredTrips)).inserted,1);
assert.deepEqual(db.prepare("SELECT route,standby_datetime,acceptance_status,assignment_status,agency_name FROM spx_booking_history WHERE team_id=3 AND request_id=2100").get(),{route:"A -> B",standby_datetime:"2030-01-01 10:00",acceptance_status:2,assignment_status:1,agency_name:"agency"});

const ddl = readFileSync("migrations/041_auto_accept_verification_jobs.sql", "utf8");
assert.equal(typeof repo.hasOwnedAutoAcceptVerification,"function","ownership recovery must distinguish verified auto-accept from unrelated manual ownership");
assert.equal(await repo.hasOwnedAutoAcceptVerification(1,100,"rule-1"),true);
assert.equal(await repo.hasOwnedAutoAcceptVerification(99,100,"rule-1"),false);
assert.equal(await repo.hasOwnedAutoAcceptVerification(1,100,"different-rule"),false);
db.prepare("INSERT INTO auto_accept_results (team_id,booking_id,request_id,status,reason_code,winning_attempt_trace_id) VALUES (2,9000,3001,'owned','manual_confirmed','manual-no-queue')").run();
assert.equal(await repo.hasOwnedAutoAcceptVerification(2,9000,"rule-1"),false,"manual owned rows without a matching verification intent do not suppress the rule");
await repo.createAutoAcceptVerificationIntent({...job(2,"different-rule-owned",[3002]),bookingId:9000,ruleId:"rule-2"});
db.prepare("INSERT INTO auto_accept_results (team_id,booking_id,request_id,status,reason_code,winning_attempt_trace_id) VALUES (2,9000,3002,'owned','verified_owned','different-rule-owned')").run();
assert.equal(await repo.hasOwnedAutoAcceptVerification(2,9000,"rule-1"),false);
assert.equal(await repo.hasOwnedAutoAcceptVerification(2,9000,"rule-2"),true);
const knownIdDiscovery = await repo.createAutoAcceptVerificationIntent({...job(4,"known-id-discovery",[4001]),acceptAll:true,reservationCount:5,discovery:{bookingName:"A-B",expectedAcceptedCount:5}});
assert.equal(knownIdDiscovery.record.discoveryPending,true,"known request IDs must not prematurely release a larger accept-all discovery reservation");
assert.equal(knownIdDiscovery.record.job.reservationCount,5);
await repo.updateAutoAcceptVerificationResponse({...knownIdDiscovery.record.job,reservationCount:undefined,acceptResult:{ok:true,httpStatus:200}},{now:Date.now()});
assert.equal((await repo.listAutoAcceptVerificationHolds(4))[0]?.job.reservationCount,5,"response reconstruction cannot erase the original quota reservation");
assert.match(ddl, /CREATE TABLE IF NOT EXISTS auto_accept_verification_jobs/);
assert.equal(ddl.trim(), autoAcceptVerificationJobsMigrationSql.trim(), "append-only migration matches runtime SQL exactly");
assert.match(readFileSync("src/db/client.ts", "utf8"), /pool.query\(autoAcceptVerificationJobsMigrationSql\)/);
assert.match(readFileSync("src/scripts/generate-migration.ts", "utf8"), /autoAcceptVerificationJobsMigrationSql/);
assert.match(readFileSync("scripts/schema-verify.mjs", "utf8"), /auto_accept_verification_jobs:/);
assert.ok(db.prepare("PRAGMA table_info(auto_accept_verification_jobs)").all().length > 8);
await closePool();
console.log("auto-accept verification repository tests passed");

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
