import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { getAutoAcceptVerificationRunner, stopAutoAcceptVerificationRecovery } from "../src/services/notifier.js";
import { importHistoricalAutoAcceptVerifications, listAutoAcceptVerificationJobs } from "../src/repositories/auto-accept-verification-repository.js";
import type { ApiClient } from "../src/services/api-client.js";

async function main() {
  env.SAVE_TO_DB = true;
  const db = getRawMemoryDb();
  for (const teamId of [1, 2]) {
    const ruleId = `legacy-history-${teamId}`;
    db.prepare("INSERT INTO notify_rules (id,team_id,name,need,auto_accept) VALUES (?,?,?,2,1)").run(ruleId, teamId, ruleId);
    db.prepare("INSERT INTO auto_accept_history (team_id,rule_id,rule_name,booking_id,request_ids,status,failure_reason,trace_id) VALUES (?,?,?,300,'[301]','indeterminate','verify_indeterminate',?)")
      .run(teamId, ruleId, ruleId, ruleId);
    assert.equal(await importHistoricalAutoAcceptVerifications(teamId), 1);
    const client = { fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean }) => ({
      retcode: 0, data: { request_list: options.tabPendingConfirmation ? [] : [301, 999].map(request_id => ({
        request_id, request_acceptance_status: 2, request_assignment_status: 1,
        booking_date: 1781136000, standby_time: 960, cost_type: 1, trip_type: 1, shift_type: 0,
        vehicle_type: 13, vehicle_type_name: "6WH",
        route_detail_list: [{ node_info_list: [{ name: "NORC-B" }] }, { node_info_list: [{ name: "SOCW" }] }],
      })) },
    }), acceptBookingRequests: async () => assert.fail("historical recovery cannot send acceptance") } as unknown as ApiClient;
    const poller = new Poller(undefined, { teamId, teamName: "Test", apiClient: client, lineGroupId: "", biddingVehicleType: 13 });
    const options = (poller as unknown as { verificationOptions: () => Parameters<typeof getAutoAcceptVerificationRunner>[1] }).verificationOptions();
    const runner = getAutoAcceptVerificationRunner(client, { ...options, canVerify: () => true });
    try {
      await runner.runDue(Date.now() + 1000);
      await runner.idle();
      const history = db.prepare("SELECT booking_id,route,origin,destination,vehicle_type,acceptance_status,assignment_status FROM spx_booking_history WHERE team_id=? AND request_id=301").get(teamId);
      assert.deepEqual(history, { booking_id: 300, route: "NORC-B -> SOCW", origin: "NORC-B", destination: "SOCW", vehicle_type: "6WH", acceptance_status: 2, assignment_status: 1 },
        "imported ordinary verification must hydrate provider metadata before the real Poller history save");
      assert.equal(db.prepare("SELECT request_id FROM spx_booking_history WHERE team_id=? AND request_id=999").get(teamId), undefined,
        "ordinary recovery cannot import an unrelated request from the same provider response");
      assert.equal((await listAutoAcceptVerificationJobs(teamId)).length, 0, "successful history save must allow notification acknowledgement");
    } finally { await stopAutoAcceptVerificationRecovery(client, teamId); }
  }
  await closePool();
  console.log("historical recovery hydrates metadata and completes real history save for both teams");
}
main().catch(error => { console.error(error); process.exit(1); });
