import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";
import { createAutoAcceptVerificationIntent } from "../src/repositories/auto-accept-verification-repository.js";
import {
  getAutoAcceptVerificationRunner, stopAutoAcceptVerificationRecovery, type NeedBudget,
} from "../src/services/notifier.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import type { NotifyRule } from "../src/services/notify-rules.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";

type Path = "fast" | "ordinary" | "detailed-all";
type Harness = {
  processOneBooking: (booking: Booking) => Promise<boolean>;
  verificationOptions: () => Parameters<typeof getAutoAcceptVerificationRunner>[1];
  tickNeedBudget: NeedBudget;
};
let nextBookingId = 9_970_000;

function fixture(path: Path) {
  const bookingId = nextBookingId += 10;
  const requestId = bookingId + 1;
  const acceptAll = path !== "ordinary";
  const rule: NotifyRule = {
    id: `prepare-${bookingId}`, name: "Persistence recovery", origins: ["NORC-B"], destinations: ["SOCW"],
    vehicle_types: ["6WH"], need: acceptAll ? 5 : 1, enabled: true, fulfilled: false,
    auto_accept: true, accept_all: acceptAll, auto_accepted: false,
  };
  const db = getRawMemoryDb();
  const rules = [rule];
  const saveRule = (item: NotifyRule) => db.prepare("INSERT INTO notify_rules (id,team_id,name,origins,destinations,vehicle_types,need,auto_accept,accept_all) VALUES (?,1,?,'[\"NORC-B\"]','[\"SOCW\"]','[\"6WH\"]',?,1,?)")
    .run(item.id, item.name, item.need, item.accept_all ? 1 : 0);
  saveRule(rule);
  let posts = 0;
  let snapshotRequestId = requestId;
  let pendingVisible = true;
  let confirmedStatus: number | undefined;
  const list = (pending: boolean): BookingRequestListResponse => ({ retcode: 0, message: "", data: {
    pageno: 1, count: 100, total: (pending ? pendingVisible : confirmedStatus !== undefined) ? 1 : 0,
    request_list: (pending ? pendingVisible : confirmedStatus !== undefined) ? [{ request_id: snapshotRequestId, booking_id: bookingId,
      booking_date: 1781136000, standby_time: 960, cost_type: 1, trip_type: 1, shift_type: 0,
      vehicle_type: 13, vehicle_type_name: "6WH", request_acceptance_status: pending ? 1 : confirmedStatus, request_assignment_status: 0,
      route_detail_list: [{ node_info_list: [{ name: "NORC-B" }] }, { node_info_list: [{ name: "SOCW" }] }],
    }] : [],
  } }) as BookingRequestListResponse;
  const post = async () => {
    posts++;
    // An ambiguous POST with unreadable tabs must keep its admission after recovery.
    return { ok: false, httpStatus: 0, response: null };
  };
  const client = {
    fetchBookingRequestList: async (_id: number, options: { tabPendingConfirmation?: boolean } = {}) =>
      posts > 0 && options.tabPendingConfirmation === false && confirmedStatus === undefined ? null : list(options.tabPendingConfirmation !== false),
    acceptBookingRequests: post,
    acceptAllBookingRequests: post,
  } as unknown as ApiClient;
  const poller = new Poller(undefined, { teamId: 1, teamName: "Test", apiClient: client, lineGroupId: "", biddingVehicleType: 13 });
  Object.assign(poller, { tickAutoAcceptRules: rules });
  const harness = poller as unknown as Harness;
  const runner = getAutoAcceptVerificationRunner(client, harness.verificationOptions());
  const booking = { booking_id: bookingId, agency_name: "SPX",
    booking_name: path === "fast" ? "[ADHOC] NORC-B > SOCW" : "[ADHOC] Route from detail",
  } as Booking;
  const jobs = () => (db.prepare("SELECT count(*) AS n FROM auto_accept_verification_jobs WHERE trace_id LIKE ?").get(`aa:1:${bookingId}:%`) as { n: number }).n;
  return { bookingId, requestId, booking, rule, db, harness, runner, client, jobs, posts: () => posts,
    addMatchingRule: () => { const second = { ...rule, id: `${rule.id}-second` }; saveRule(second); rules.push(second); },
    setSnapshot: (id = requestId, pending = true, confirmed?: number) => {
      snapshotRequestId = id; pendingVisible = pending; confirmedStatus = confirmed;
    },
    stop: () => stopAutoAcceptVerificationRecovery(client, 1) };
}

async function rolledBackIntentCanRetry(path: Path): Promise<void> {
  const f = fixture(path);
  try {
    f.db.exec("CREATE TRIGGER fail_prepare BEFORE INSERT ON auto_accept_verification_jobs BEGIN SELECT RAISE(ABORT, 'injected intent rollback'); END");
    await f.harness.processOneBooking(f.booking);
    f.db.exec("DROP TRIGGER fail_prepare");
    assert.equal(f.posts(), 0, `${path}: persistence failure must precede any POST`);
    assert.equal(f.jobs(), 0, `${path}: the failed transaction left no durable intent`);

    await f.harness.processOneBooking(f.booking);
    await f.runner.idle();
    assert.equal(f.posts(), 1, `${path}: DB recovery must release the pre-POST claim and dedupe immediately`);
    assert.equal(f.jobs(), 1);
    await f.harness.processOneBooking(f.booking);
    assert.equal(f.posts(), 1, `${path}: an ambiguous POST must not release the recovered admission`);
  } finally {
    f.db.exec("DROP TRIGGER IF EXISTS fail_prepare");
    await f.stop();
  }
}

async function committedIntentKeepsAdmission(path: Path, callbackObserved: boolean): Promise<void> {
  const f = fixture(path);
  const prepare = f.runner.prepare.bind(f.runner);
  try {
    f.runner.prepare = async (job, onPersisted) => {
      if (callbackObserved) await prepare(job, onPersisted);
      else await createAutoAcceptVerificationIntent(job);
      throw new Error("injected failure after durable commit");
    };
    await f.harness.processOneBooking(f.booking);
    f.runner.prepare = prepare;
    assert.equal(f.jobs(), 1, `${path}: preparation committed before its acknowledgement was lost`);
    await f.harness.processOneBooking(f.booking);
    assert.equal(f.posts(), 0, `${path}: existing durable intent stays read-only after a preparation error`);
    assert.equal(f.harness.tickNeedBudget.claim(f.rule.id, f.rule.need, f.rule.need).granted, 0,
      `${path}: committed intent keeps its complete quota reservation`);
  } finally { await f.stop(); }
}

async function responseWriteFailureKeepsAdmission(path: Path): Promise<void> {
  const f = fixture(path);
  try {
    f.db.exec("CREATE TRIGGER fail_response BEFORE UPDATE ON auto_accept_verification_jobs WHEN NEW.response_ready=1 AND OLD.response_ready=0 BEGIN SELECT RAISE(ABORT, 'injected response save failure'); END");
    await f.harness.processOneBooking(f.booking);
    f.db.exec("DROP TRIGGER fail_response");
    assert.equal(f.posts(), 1);
    assert.equal(f.jobs(), 1);
    await f.harness.processOneBooking(f.booking);
    assert.equal(f.posts(), 1, `${path}: a response save failure must never permit another POST`);
    assert.equal(f.harness.tickNeedBudget.claim(f.rule.id, f.rule.need, f.rule.need).granted, 0);
  } finally {
    f.db.exec("DROP TRIGGER IF EXISTS fail_response");
    await f.stop();
  }
}

async function unavailableConfirmationCanRetryLater(path: Path): Promise<void> {
  const f = fixture(path);
  const prepare = f.runner.prepare.bind(f.runner);
  const prepareSql = f.db.prepare.bind(f.db);
  let confirmationUnavailable = false;
  try {
    f.db.prepare = ((sql: string) => {
      if (confirmationUnavailable && sql.includes("auto_accept_verification_jobs") && sql.includes("ORDER BY next_attempt_at")) {
        throw new Error("injected persistence confirmation outage");
      }
      return prepareSql(sql);
    }) as typeof f.db.prepare;
    f.runner.prepare = async () => {
      confirmationUnavailable = true;
      throw new Error("injected preparation outage");
    };
    await f.harness.processOneBooking(f.booking);
    assert.equal(f.posts(), 0);
    f.harness.tickNeedBudget.beginTick(Date.now() + 600_000);
    assert.equal(f.harness.tickNeedBudget.claim(f.rule.id, f.rule.need, f.rule.need).granted, 0,
      `${path}: unknown persistence cannot expire with an ordinary claim`);
    confirmationUnavailable = false;
    f.runner.prepare = prepare;
    await f.harness.processOneBooking(f.booking);
    await f.runner.idle();
    assert.equal(f.posts(), 1, `${path}: a later admission rechecks the now-readable DB and retries an absent intent`);
  } finally {
    f.db.prepare = prepareSql;
    await f.stop();
  }
}

async function multipleRulesKeepCommittedIntentScoped(path: Path): Promise<void> {
  const f = fixture(path);
  f.addMatchingRule();
  const prepare = f.runner.prepare.bind(f.runner);
  try {
    f.runner.prepare = async job => {
      await createAutoAcceptVerificationIntent(job);
      throw new Error("injected lost commit acknowledgement with two matching rules");
    };
    await f.harness.processOneBooking(f.booking);
    f.runner.prepare = prepare;
    assert.equal(f.jobs(), 1);
    assert.equal(f.posts(), 0);
    // A sibling is also covered by accept_all. Ordinary jobs instead protect
    // their original request from the poller's legacy own-status reconciliation.
    if (path === "detailed-all") f.setSnapshot(f.requestId + 1);
    if (path === "ordinary") f.setSnapshot(f.requestId, false, 2);
    await f.harness.processOneBooking(f.booking);
    await f.runner.idle();
    assert.equal(f.posts(), 0, `${path}: another matching rule must not POST over a committed preparation`);
    assert.equal(f.jobs(), 1, `${path}: another rule must not create a competing durable intent`);
    assert.equal((f.db.prepare("SELECT need FROM notify_rules WHERE id=?").get(f.rule.id) as { need: number }).need,
      f.rule.need, `${path}: durable verification retains sole ownership of progress settlement`);
  } finally { await f.stop(); }
}

async function multipleRulesKeepUnknownPreparationScoped(path: Path): Promise<void> {
  const f = fixture(path);
  f.addMatchingRule();
  const prepare = f.runner.prepare.bind(f.runner);
  const prepareSql = f.db.prepare.bind(f.db);
  let confirmationUnavailable = false;
  try {
    f.db.prepare = ((sql: string) => {
      if (confirmationUnavailable && sql.includes("auto_accept_verification_jobs") && sql.includes("ORDER BY next_attempt_at")) {
        throw new Error("injected confirmation outage with two matching rules");
      }
      return prepareSql(sql);
    }) as typeof f.db.prepare;
    f.runner.prepare = async () => {
      confirmationUnavailable = true;
      throw new Error("injected unknown preparation with two matching rules");
    };
    await f.harness.processOneBooking(f.booking);
    f.runner.prepare = prepare;
    if (path === "detailed-all") f.setSnapshot(f.requestId + 1);
    if (path === "ordinary") f.setSnapshot(f.requestId, false, 2);
    await f.harness.processOneBooking(f.booking);
    await f.runner.idle();
    assert.equal(f.posts(), 0, `${path}: unknown preparation blocks another rule while confirmation is unavailable`);
    assert.equal(f.jobs(), 0);
    assert.equal((f.db.prepare("SELECT need FROM notify_rules WHERE id=?").get(f.rule.id) as { need: number }).need,
      f.rule.need, `${path}: unknown preparation cannot bypass verification through legacy progress`);

    confirmationUnavailable = false;
    f.setSnapshot();
    await f.harness.processOneBooking(f.booking);
    await f.runner.idle();
    assert.equal(f.posts(), 1, `${path}: confirmed absence releases the cross-rule guard for exactly one POST`);
    assert.equal(f.jobs(), 1);
    await f.harness.processOneBooking(f.booking);
    assert.equal(f.posts(), 1);
  } finally {
    f.db.prepare = prepareSql;
    await f.stop();
  }
}

async function main(): Promise<void> {
  Object.assign(env, { AUTO_ACCEPT_ENABLED: true, SAVE_TO_DB: false, FETCH_DETAILS: false, SPX_ROLE: "monolith" });
  setLogLevel(LogLevel.ERROR);
  const failures: unknown[] = [];
  try {
    for (const path of ["fast", "ordinary", "detailed-all"] as const) {
      for (const test of [rolledBackIntentCanRetry, unavailableConfirmationCanRetryLater,
        (selected: Path) => committedIntentKeepsAdmission(selected, true),
        (selected: Path) => committedIntentKeepsAdmission(selected, false), responseWriteFailureKeepsAdmission,
        multipleRulesKeepCommittedIntentScoped, multipleRulesKeepUnknownPreparationScoped]) {
        try { await test(path); }
        catch (error) { failures.push(error); console.error(error); }
      }
    }
    assert.equal(failures.length, 0, "pre-POST persistence regressions must all pass");
    console.log("pre-POST persistence recovery: fast/ordinary/detailed acceptance retries only absent intents; committed/ambiguous submissions retain holds");
  } finally { await closePool(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
