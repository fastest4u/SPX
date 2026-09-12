import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { getAutoAcceptVerificationRunner, stopAutoAcceptVerificationRecovery } from "../src/services/notifier.js";
import { listAutoAcceptVerificationHolds } from "../src/repositories/auto-accept-verification-repository.js";
import { getAutoAcceptResult } from "../src/repositories/auto-accept-result-repository.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

const bookingId = 998801;
const requestId = 998802;
const booking = { booking_id: bookingId, booking_name: "[ADHOC] NORC-B > SOCW", agency_name: "SPX" } as Booking;
const rule: NotifyRule = {
  id: "poller-verification-recovery", name: "Recovery overlap", origins: ["NORC-B"], destinations: ["SOCW"],
  vehicle_types: ["6WH"], need: 5, enabled: true, fulfilled: false, auto_accept: true,
  accept_all: false, auto_accepted: false,
};
function response(status?: number): BookingRequestListResponse {
  const request_list = status === undefined ? [] : [{
    request_id: requestId, booking_id: bookingId, booking_date: 1781136000, standby_time: 960,
    cost_type: 1, trip_type: 1, shift_type: 0, vehicle_type: 13, vehicle_type_name: "6WH",
    request_acceptance_status: status, request_assignment_status: 0,
    route_detail_list: [{ node_info_list: [{ name: "NORC-B" }] }, { node_info_list: [{ name: "SOCW" }] }],
  }];
  return { retcode: 0, message: "", data: { pageno: 1, count: 100, total: request_list.length, request_list } } as BookingRequestListResponse;
}
type Harness = {
  processOneBooking: (booking: Booking) => Promise<boolean>;
  verificationOptions: () => Parameters<typeof getAutoAcceptVerificationRunner>[1];
  nonPendingAttemptedKeys: Set<string>;
};

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(env, { AUTO_ACCEPT_ENABLED: true, FETCH_DETAILS: false, SAVE_TO_DB: false, SPX_ROLE: "monolith" });
  const db = getRawMemoryDb();
  db.prepare("INSERT INTO notify_rules (id,team_id,name,origins,destinations,vehicle_types,need,auto_accept) VALUES (?,1,?,'[\"NORC-B\"]','[\"SOCW\"]','[\"6WH\"]',5,1)").run(rule.id, rule.name);
  const need = () => (db.prepare("SELECT need FROM notify_rules WHERE id=?").get(rule.id) as { need: number }).need;
  let phase: "initial" | "unreadable" | "poll" | "recover" = "initial";
  let status = 2;
  let stalePendingSnapshot = false;
  let posts = 0;
  const client = {
    fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean } = {}) => {
      if (phase === "unreadable") return null;
      const pending = options.tabPendingConfirmation !== false;
      if (phase === "initial") return pending ? response(1) : response();
      return pending ? response(stalePendingSnapshot ? 1 : undefined) : response(phase === "recover" ? 2 : status);
    },
    acceptBookingRequests: async () => {
      posts++;
      phase = "unreadable";
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "", data: {} } };
    },
  } as unknown as ApiClient;
  const makePoller = () => {
    const poller = new Poller(undefined, { teamId: 1, teamName: "Test", apiClient: client, lineGroupId: "", biddingVehicleType: 13 });
    Object.assign(poller, { tickAutoAcceptRules: [rule] });
    return poller as unknown as Harness;
  };
  let poller = makePoller();
  let runner = getAutoAcceptVerificationRunner(client, poller.verificationOptions());
  try {
    await poller.processOneBooking(booking);
    await runner.idle();
    assert.equal(posts, 1, "initial normal poll submits once");
    assert.equal((await listAutoAcceptVerificationHolds(1)).length, 1);
    assert.equal(need(), 5);

    // A new worker must restore pending holds before its ordinary detail path.
    await stopAutoAcceptVerificationRecovery(client, 1);
    poller = makePoller();
    runner = getAutoAcceptVerificationRunner(client, poller.verificationOptions());
    phase = "poll";
    for (status of [2, 4, 1]) {
      await poller.processOneBooking(booking);
      assert.equal(need(), 5, `status ${status} cannot settle pending durable work through legacy progress`);
      assert.equal(posts, 1, `status ${status} cannot replay a pending accept`);
    }
    stalePendingSnapshot = true;
    await poller.processOneBooking(booking);
    assert.equal(posts, 1, "the ordinary pending-tab path also honors restored durable holds");
    assert.equal(need(), 5);
    stalePendingSnapshot = false;

    phase = "recover";
    await runner.runDue(Date.now() + 600_000);
    await runner.idle();
    assert.equal(need(), 4, "durable recovery decrements exactly once");
    assert.equal((await getAutoAcceptResult(1, bookingId, requestId))?.status, "owned");
    assert.equal((await listAutoAcceptVerificationHolds(1)).length, 0);

    // Simulate a restart/dedupe eviction after completion: canonical ownership
    // must prevent legacy recount even though there is no pending queue record.
    await stopAutoAcceptVerificationRecovery(client, 1);
    poller = makePoller();
    runner = getAutoAcceptVerificationRunner(client, poller.verificationOptions());
    phase = "poll";
    for (status of [2, 4, 1]) {
      poller.nonPendingAttemptedKeys.clear();
      await poller.processOneBooking(booking);
      assert.equal(need(), 4, `stale status ${status} cannot recount canonical ownership`);
      assert.equal(posts, 1);
    }
    const histories = db.prepare("SELECT status,accepted_count FROM auto_accept_history WHERE booking_id=?").all(bookingId);
    assert.deepEqual(histories, [{ status: "success", accepted_count: 1 }], "one durable winning history remains authoritative");
    console.log("poller verification recovery: pending/restart fences, no repeated POST, canonical quota once passed");
  } finally {
    await stopAutoAcceptVerificationRecovery(client, 1);
    await closePool();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
