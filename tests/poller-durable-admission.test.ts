import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import {
  NeedBudget, getAutoAcceptVerificationRunner, stopAutoAcceptVerificationRecovery,
} from "../src/services/notifier.js";
import {
  acknowledgeAutoAcceptVerificationNotification, claimAutoAcceptVerificationJob,
  createAutoAcceptVerificationIntent, listAutoAcceptVerificationHolds,
  settleAutoAcceptVerificationJob,
} from "../src/repositories/auto-accept-verification-repository.js";
import { upsertAutoAcceptResult } from "../src/repositories/auto-accept-result-repository.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";
import type { AutoAcceptVerificationJob, AutoAcceptVerificationOutcome } from "../src/services/auto-accept-verifier.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

const booking = (id: number) => ({
  booking_id: id, booking_name: "[ADHOC] NORC-B > SOCW", agency_name: "SPX",
}) as Booking;

function response(bookingId: number, requestId?: number): BookingRequestListResponse {
  const request_list = requestId === undefined ? [] : [{
    request_id: requestId, booking_id: bookingId, booking_date: 1781136000, standby_time: 960,
    cost_type: 1, trip_type: 1, shift_type: 0, vehicle_type: 13, vehicle_type_name: "6WH",
    request_acceptance_status: 1, request_assignment_status: 0,
    route_detail_list: [{ node_info_list: [{ name: "NORC-B" }] }, { node_info_list: [{ name: "SOCW" }] }],
  }];
  return { retcode: 0, message: "", data: { pageno: 1, count: 100, total: request_list.length, request_list } } as BookingRequestListResponse;
}

function makeRule(teamId: number, suffix: string, acceptAll: boolean): NotifyRule {
  const rule: NotifyRule = {
    id: `durable-admission-${teamId}-${suffix}`, name: "Durable admission", origins: ["NORC-B"],
    destinations: ["SOCW"], vehicle_types: ["6WH"], need: 5, enabled: true, fulfilled: false,
    auto_accept: true, accept_all: acceptAll, auto_accepted: false,
  };
  getRawMemoryDb().prepare("INSERT INTO notify_rules (id,team_id,name,origins,destinations,vehicle_types,need,auto_accept,accept_all) VALUES (?,?,?,'[\"NORC-B\"]','[\"SOCW\"]','[\"6WH\"]',5,1,?)")
    .run(rule.id, teamId, rule.name, acceptAll ? 1 : 0);
  return rule;
}

type Harness = {
  processOneBooking: (item: Booking) => Promise<boolean>;
  verificationOptions: () => Parameters<typeof getAutoAcceptVerificationRunner>[1];
  tickNeedBudget: NeedBudget;
};

function makePoller(teamId: number, apiClient: ApiClient, rule: NotifyRule): Harness {
  const poller = new Poller(undefined, { teamId, teamName: "Test", apiClient, lineGroupId: "", biddingVehicleType: 13 });
  Object.assign(poller, { tickAutoAcceptRules: [rule], tickNeedBudget: new NeedBudget() });
  return poller as unknown as Harness;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Seed only through the durable repository. Calling the notifier here would seed
// module-level dedupe and conceal the restart defect that this test exercises.
async function seedCompletedOwned(teamId: number, rule: NotifyRule, bookingId: number, requestId: number): Promise<void> {
  const job: AutoAcceptVerificationJob = {
    teamId, ruleId: rule.id, ruleName: rule.name, bookingId, requestIds: [requestId],
    trips: [{ request_id: requestId, booking_id: bookingId }], claimToken: 0,
    acceptResult: { ok: true, httpStatus: 200 }, acceptStartedAt: 1, acceptFinishedAt: 2,
    acceptRttMs: 1, ambiguousAccept: false, acceptAll: rule.accept_all, traceId: `seed-owned-${teamId}-${bookingId}`,
    ...(rule.accept_all ? { reservationCount: 1, discovery: {
      bookingName: booking(bookingId).booking_name, expectedAcceptedCount: 1, verifiedRequestIds: [requestId],
    } } : {}),
  };
  await createAutoAcceptVerificationIntent(job, { now: 1000, postRecoveryDelayMs: 0 });
  const lease = await claimAutoAcceptVerificationJob(teamId, job.traceId, { now: 1000 });
  assert.ok(lease?.leaseToken);
  const outcome: AutoAcceptVerificationOutcome = {
    job, verificationStatus: "verified_success", acceptedRequestIds: [requestId], failedRequestIds: [],
    indeterminateRequestIds: [], discoveryPending: false,
    requests: [{ requestId, status: "accepted", observedStatus: 2, terminal: true, releaseRequestDedupe: false, releaseBudget: false }],
    evidence: { traceId: job.traceId, verificationStatus: "verified_success", pendingTabRead: true,
      confirmedTabRead: true, observedStatuses: { [requestId]: 2 }, nextAction: "complete" },
  };
  const settled = await settleAutoAcceptVerificationJob(teamId, job.traceId, lease.leaseToken, outcome, { now: 1001 });
  assert.deepEqual(settled.newlyAcceptedRequestIds, [requestId]);
  for (const notification of settled.record!.notifications) {
    await acknowledgeAutoAcceptVerificationNotification(teamId, job.traceId, notification.id);
  }
  assert.equal((await listAutoAcceptVerificationHolds(teamId)).some(row => row.job.traceId === job.traceId), false);
}

async function completedPendingAdmission(teamId: number): Promise<void> {
  const id = 9_910_000 + teamId * 100;
  const rule = makeRule(teamId, "normal", false);
  await seedCompletedOwned(teamId, rule, id, id + 1);
  const posts: number[][] = [];
  const client = {
    fetchBookingRequestList: async (bookingId: number, options: { tabPendingConfirmation?: boolean } = {}) =>
      response(bookingId, options.tabPendingConfirmation === false ? undefined : bookingId + 1),
    acceptBookingRequests: async (_bookingId: number, requestIds: number[]) => {
      posts.push(requestIds);
      return { ok: false, httpStatus: 0, response: null };
    },
  } as unknown as ApiClient;
  const poller = makePoller(teamId, client, rule);
  try {
    await poller.processOneBooking(booking(id));
    await getAutoAcceptVerificationRunner(client, poller.verificationOptions()).idle();
    assert.deepEqual(posts, [], "a fresh worker must not replay a completed owned request from stale pending status 1");
    await poller.processOneBooking(booking(id + 10));
    await getAutoAcceptVerificationRunner(client, poller.verificationOptions()).idle();
    assert.deepEqual(posts, [[id + 11]], "an unrelated pending request proves normal acceptance remains enabled");
  } finally { await stopAutoAcceptVerificationRecovery(client, teamId); }
}

async function completedFastAdmission(teamId: number): Promise<void> {
  const id = 9_920_000 + teamId * 100;
  const rule = makeRule(teamId, "fast-owned", true);
  await seedCompletedOwned(teamId, rule, id, id + 1);
  await upsertAutoAcceptResult({ teamId, bookingId: id + 10, requestId: id + 11,
    winningAttemptTraceId: "manual-owned-without-durable-job", status: "owned", reasonCode: "verified_owned",
    evidence: { source: "manual" } });
  const posts: number[] = [];
  const client = {
    fetchBookingRequestList: async () => null,
    acceptAllBookingRequests: async (bookingId: number) => {
      posts.push(bookingId);
      return { ok: false, httpStatus: 0, response: null };
    },
  } as unknown as ApiClient;
  const poller = makePoller(teamId, client, rule);
  try {
    await poller.processOneBooking(booking(id));
    await getAutoAcceptVerificationRunner(client, poller.verificationOptions()).idle();
    assert.deepEqual(posts, [], "a fresh fast-path worker must not replay a completed booking for the same rule");
    await poller.processOneBooking(booking(id + 10));
    await getAutoAcceptVerificationRunner(client, poller.verificationOptions()).idle();
    assert.deepEqual(posts, [id + 10], "manual ownership of a sibling must not block accepting the rest of an unrelated booking");
  } finally { await stopAutoAcceptVerificationRecovery(client, teamId); }
}

async function acceptAllQuotaAdmission(teamId: number, acknowledged: boolean, detailed = false): Promise<void> {
  const id = (detailed ? 9_940_000 : 9_930_000) + teamId * 100;
  const rule = makeRule(teamId, detailed ? "detail-quota" : "fast-quota", true);
  const item = (bookingId: number): Booking => ({ ...booking(bookingId),
    ...(detailed ? { booking_name: "[ADHOC] Route supplied by request detail" } : {}) });
  const postStarted = deferred();
  const postResponse = deferred();
  let posts = 0;
  const client = {
    fetchBookingRequestList: async (bookingId: number, options: { tabPendingConfirmation?: boolean } = {}) =>
      detailed ? response(bookingId, options.tabPendingConfirmation === false ? undefined : bookingId + 1) : null,
    acceptAllBookingRequests: async () => {
      posts++;
      postStarted.resolve();
      if (posts === 1) await postResponse.promise;
      return acknowledged
        ? { ok: true, httpStatus: 200, response: { retcode: 0, message: "", data: { success_count: 5 } } }
        : { ok: false, httpStatus: 0, response: null };
    },
  } as unknown as ApiClient;
  let poller = makePoller(teamId, client, rule);
  let first: Promise<boolean> | undefined;
  try {
    first = poller.processOneBooking(item(id));
    await postStarted.promise;
    const beforeResponse = (await listAutoAcceptVerificationHolds(teamId)).find(row => row.job.bookingId === id);
    assert.equal(beforeResponse?.job.reservationCount, 5, "the complete quota must persist before the accept_all response is known");
    assert.deepEqual(beforeResponse?.job.requestIds, detailed ? [id + 1] : [],
      "the detailed path starts discovery with one known request; the fast path has no IDs yet");
    assert.equal(beforeResponse?.discoveryPending, true, "one known ID does not finish whole-booking discovery before POST completion");
    await poller.processOneBooking(item(id + 10));
    assert.equal(posts, 1, "another booking must not submit while the first accept_all POST is unresolved");
    postResponse.resolve();
    await first;
    await getAutoAcceptVerificationRunner(client, poller.verificationOptions()).idle();
    const afterResponse = (await listAutoAcceptVerificationHolds(teamId)).find(row => row.job.bookingId === id);
    assert.equal(afterResponse?.job.reservationCount, 5);
    assert.equal(afterResponse?.job.discovery?.expectedAcceptedCount, acknowledged ? 5 : 1);
    poller.tickNeedBudget.beginTick(Date.now() + 86_400_000);
    await poller.processOneBooking(item(id + 10));
    assert.equal(posts, 1, "a new tick must retain the full quota while whole-booking acceptance is unproven");
    await stopAutoAcceptVerificationRecovery(client, teamId);
    poller = makePoller(teamId, client, rule);
    await poller.processOneBooking(item(id + 10));
    assert.equal(posts, 1, "restart restores the full reservation before admitting a different booking");
  } finally {
    postResponse.resolve();
    await first;
    await stopAutoAcceptVerificationRecovery(client, teamId);
  }
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  Object.assign(env, { AUTO_ACCEPT_ENABLED: true, FETCH_DETAILS: false, SAVE_TO_DB: false, SPX_ROLE: "monolith" });
  try {
    for (const teamId of [1, 2]) await completedPendingAdmission(teamId);
    for (const teamId of [1, 2]) await completedFastAdmission(teamId);
    await acceptAllQuotaAdmission(1, false);
    await acceptAllQuotaAdmission(2, true);
    await acceptAllQuotaAdmission(1, false, true);
    await acceptAllQuotaAdmission(2, true, true);
    console.log("poller durable admission: completed ownership, full accept_all quota before/after response and restart, manual sibling isolation passed");
  } finally { await closePool(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
