import assert from "node:assert/strict";
import { Poller } from "../src/controllers/poller.js";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb, resetMemoryDb } from "../src/db/client-memory.js";
import { enablePublication, fencePublication, getPublicationControlHistory } from "../src/repositories/auto-accept-publication-control-repository.js";
import { createRule, readRules, type NotifyRule } from "../src/services/notify-rules.js";
import { awaitAutoAcceptVerificationIdle, NeedBudget } from "../src/services/notifier.js";
import { validateAutoAcceptJobDryRunPayloadStructure } from "../src/services/auto-accept-job-dry-run.js";
import { getAutoAcceptJobByIdempotencyKey } from "../src/repositories/auto-accept-job-repository.js";
import { runAutoAcceptJobRealExecutionBatch } from "../src/services/auto-accept-job-real-execution.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { Booking, BookingRequestListResponse } from "../src/models/types.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";

type Request = BookingRequestListResponse["data"]["request_list"][number];
const mutable = env as { -readonly [K in keyof typeof env]: (typeof env)[K] };
const original = { ...mutable };
const nodeId = "poller-cutover-test";
const epoch = "local-cutover-1";
const pollers: Poller[] = [];

function request(id: number, status: number, origin = "A", vehicle = 13): Request {
  return {
    request_id: id, booking_id: 100, booking_date: 1782144000,
    request_acceptance_status: status, vehicle_type: vehicle, vehicle_type_name: "6WH",
    route_detail_list: [origin, "B"].map((name, route_level) => ({
      route_level, node_info_list: [{ name }],
    })),
  } as Request;
}
function page(items: Request[]): BookingRequestListResponse {
  return { retcode: 0, message: "", data: { pageno: 1, count: items.length, total: items.length, request_list: items } };
}
const booking = { booking_id: 100, booking_name: "[ADHOC] A > B 2026-09-12", agency_name: "SPX", ctime: 1789189200 } as Booking;
function jobs() {
  return getRawMemoryDb().prepare("SELECT * FROM auto_accept_jobs ORDER BY id").all() as Array<{
    id: number; idempotency_key: string; attempt_kind: string; request_id: number;
    cutover_epoch: string | null; publication_generation: number | null; payload_json: string;
  }>;
}
async function setup(options: { role?: typeof env.SPX_ROLE; shadow?: boolean; pendingCutover?: boolean; fastCutover?: boolean; allowTeam?: number; acceptAll?: boolean; controlled?: boolean } = {}) {
  for (const poller of pollers.splice(0)) await poller.stop();
  await closePool();
  resetMemoryDb();
  Object.assign(mutable, {
    AUTO_ACCEPT_ENABLED: true, FETCH_DETAILS: false, SAVE_TO_DB: false, HTTP_ENABLED: false,
    SPX_ROLE: options.role ?? "poller-service", SPX_NODE_ID: nodeId, BIDDING_VEHICLE_TYPE: 13,
    AUTO_ACCEPT_JOB_SHADOW_ENABLED: options.shadow ?? false,
    AUTO_ACCEPT_JOB_CUTOVER_EPOCH: options.controlled === false ? "" : epoch,
    AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED: options.pendingCutover ?? false,
    AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS: [options.allowTeam ?? 1],
    AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: options.fastCutover ?? false,
    AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: [options.allowTeam ?? 1],
  });
  const rule = await createRule(1, { name: "Cutover A", origins: ["A"], destinations: ["B"], vehicle_types: ["6WH"], need: 2, enabled: true, accept_all: options.acceptAll ?? false });
  if (options.controlled !== false) await enablePublication({ teamId: 1, epoch, pollerNodeId: nodeId });
  return rule;
}
function makePoller(rules: NotifyRule[], pending: Request[], confirmed: Request[] = [], allowProvider = true) {
  const events: string[] = [];
  let accepted = false;
  const api = {
    fetchBookingRequestList: async (_id: number, options?: { onPage?: (response: BookingRequestListResponse) => boolean | void; tabPendingConfirmation?: boolean }) => {
      const isConfirmed = options?.tabPendingConfirmation === false;
      events.push(isConfirmed ? "confirmed" : "pending");
      const response = page(accepted ? (isConfirmed ? pending.map((trip) => ({ ...trip, request_acceptance_status: 2 })) : []) : (isConfirmed ? confirmed : pending));
      options?.onPage?.(response);
      return response;
    },
    acceptBookingRequests: async () => { events.push("accept"); accepted = true; return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } }; },
    acceptAllBookingRequests: async () => { events.push("accept-all"); accepted = true; return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } }; },
  } as unknown as ApiClient;
  const poller = new Poller(undefined, { teamId: 1, teamName: "Local cutover", lineGroupId: "", apiClient: api,
    manageHttpServer: false, manageProcessSignals: false, closeSharedResourcesOnStop: false, exitOnStop: false,
    beforePoll: async () => allowProvider });
  Object.assign(poller, { tickAutoAcceptRules: rules, tickNeedBudget: new NeedBudget() });
  pollers.push(poller);
  return { poller, events, process: (item = booking) => (poller as unknown as { processOneBooking(item: Booking): Promise<boolean> }).processOneBooking(item) };
}

async function main() {
  setLogLevel(LogLevel.ERROR);
  // Removing role-aware cutover would invoke provider acceptance here and leave the durable queue empty.
  let rule = await setup();
  const pending = makePoller([rule], [request(101, 1)]);
  assert.equal(await pending.process(), true);
  assert.deepEqual(pending.events, ["pending"], "dedicated poller must publish instead of accepting or verifying");
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].attempt_kind, "pending_request");
  assert.equal(jobs()[0].cutover_epoch, epoch);
  assert.equal(jobs()[0].publication_generation, 1);
  const row = await getAutoAcceptJobByIdempotencyKey(jobs()[0].idempotency_key);
  assert.ok(row && validateAutoAcceptJobDryRunPayloadStructure(row).ok, "consumer must accept the emitted contract");
  assert.equal((await readRules(1))[0].need, 2);
  assert.equal(getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM auto_accept_verification_jobs").get()!.n, 0);
  assert.equal(getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM auto_accept_history").get()!.n, 0);
  await pending.process();
  assert.equal(jobs().length, 1, "repeated discovery is durably idempotent");

  await fencePublication({ teamId: 1, epoch, pollerNodeId: nodeId });
  assert.equal(await pending.process(), false, "fenced publication must be non-clean and never fall back inline");
  assert.equal(jobs().length, 1);
  const control = (await getPublicationControlHistory(1))[0];
  assert.equal(control.ackNodeId, nodeId);
  assert.equal(control.ackJobId, jobs()[0].id);
  mutable.AUTO_ACCEPT_JOB_CUTOVER_EPOCH = "stale-local-epoch";
  assert.equal(await pending.process(), false);
  mutable.AUTO_ACCEPT_JOB_CUTOVER_EPOCH = "";
  assert.equal(await pending.process(), false, "dedicated producer cannot enqueue uncontrolled jobs");
  assert.ok(!pending.events.some((event) => event.startsWith("accept")));

  rule = await setup();
  mutable.SPX_NODE_ID = "different-poller";
  const wrongOwner = makePoller([rule], [request(109, 1)]);
  assert.equal(await wrongOwner.process(), false);
  assert.equal(jobs().length, 0, "a different producer node cannot publish against the current epoch");
  assert.deepEqual(wrongOwner.events, ["pending"]);

  rule = await setup();
  const ownRule = await createRule(1, { name: "Cutover C", origins: ["C"], destinations: ["B"], vehicle_types: ["6WH"], need: 2, enabled: true });
  const nonpending = makePoller([rule, ownRule], [], [request(102, 4), request(103, 2, "C"), request(104, 6), request(105, 9)]);
  assert.equal(await nonpending.process(), true);
  assert.deepEqual(nonpending.events, ["pending", "confirmed"]);
  assert.deepEqual(jobs().map((job) => [job.attempt_kind, job.request_id]), [["non_pending_probe", 102], ["own_status_reconcile", 103]]);

  rule = await setup({ acceptAll: true });
  const fast = makePoller([rule], []);
  assert.equal(await fast.process(), true);
  assert.deepEqual(fast.events, [], "fast parent cutover must not fetch detail or accept inline");
  assert.deepEqual(jobs().map((job) => [job.attempt_kind, job.request_id]), [["fast_accept_all", 0]]);

  rule = await setup({ role: "worker", controlled: false, acceptAll: true, fastCutover: true });
  const supervisedFast = makePoller([rule], []);
  assert.equal(await supervisedFast.process(), true);
  assert.deepEqual(supervisedFast.events, []);
  assert.equal(jobs()[0].attempt_kind, "fast_accept_all", "fast whitelist cutover publishes even with shadow off");

  rule = await setup({ acceptAll: true });
  const detailedParent = makePoller([rule], [request(110, 1)]);
  assert.equal(await detailedParent.process({ ...booking, booking_name: "[ADHOC] route unknown until detail" }), true);
  assert.deepEqual(detailedParent.events, ["pending"]);
  const parentRow = await getAutoAcceptJobByIdempotencyKey(jobs()[0].idempotency_key);
  assert.equal(parentRow?.attemptKind, "fast_accept_all", "detail-matched whole booking rule must keep whole booking semantics");
  assert.ok(parentRow && validateAutoAcceptJobDryRunPayloadStructure(parentRow).ok);

  for (const shadow of [false, true]) {
    rule = await setup({ role: "worker", controlled: false, acceptAll: true, pendingCutover: true, shadow });
    const legacyWholeBooking = makePoller([rule], [request(shadow ? 212 : 211, 1)]);
    assert.equal(await legacyWholeBooking.process({ ...booking, booking_name: "[ADHOC] route from detail" }), true);
    assert.ok(legacyWholeBooking.events.includes("accept-all"), "pending cutover must preserve disabled-fast whole booking ownership");
    assert.equal(jobs().length, shadow ? 1 : 0);
    await awaitAutoAcceptVerificationIdle();
  }

  rule = await setup({ role: "worker", controlled: false, acceptAll: true, fastCutover: true });
  const detailFastCutover = makePoller([rule], [request(213, 1)]);
  assert.equal(await detailFastCutover.process({ ...booking, booking_name: "[ADHOC] route from detail" }), true);
  assert.ok(!detailFastCutover.events.some((event) => event.startsWith("accept")));
  assert.equal(jobs()[0].attempt_kind, "fast_accept_all");

  rule = await setup({ role: "worker", controlled: false, pendingCutover: true });
  const overlappingWholeRule = await createRule(1, { name: "Whole booking overlapping owner", origins: ["A"], destinations: ["B"], vehicle_types: ["6WH"], need: 2, enabled: true, accept_all: true });
  const mixedOwners = makePoller([rule, overlappingWholeRule], [request(214, 1)]);
  assert.equal(await mixedOwners.process({ ...booking, booking_name: "[ADHOC] route from detail" }), false, "conflicting whole-booking and request owners must fail closed before either side effect");
  assert.ok(!mixedOwners.events.some((event) => event.startsWith("accept")));
  assert.equal(jobs().length, 0);

  rule = await setup({ role: "worker", controlled: false, pendingCutover: true });
  const laterWholeRule = await createRule(1, { name: "Whole booking on later page", origins: ["C"], destinations: ["B"], vehicle_types: ["6WH"], need: 2, enabled: true, accept_all: true });
  const acrossPages = makePoller([rule, laterWholeRule], [request(215, 1), request(216, 1, "C")]);
  const pagedApi = (acrossPages.poller as unknown as { apiClient: ApiClient }).apiClient;
  pagedApi.fetchBookingRequestList = async (_bookingId, options) => {
    const pages = [page([request(215, 1)]), page([request(216, 1, "C")])];
    for (const response of pages) options?.onPage?.(response);
    return page(pages.flatMap((response) => response.data.request_list));
  };
  assert.equal(await acrossPages.process({ ...booking, booking_name: "[ADHOC] route from detail" }), false, "cross-page whole-booking ownership must be decided before page 1 enqueues");
  assert.equal(jobs().length, 0);
  assert.ok(!acrossPages.events.some((event) => event.startsWith("accept")));

  rule = await setup();
  mutable.REQUEST_SELECTION_STRATEGY = "last";
  const selectedLast = makePoller([rule], [request(221, 1), request(222, 1)]);
  assert.equal(await selectedLast.process(), true);
  assert.deepEqual(jobs().map((job) => job.request_id), [222, 221], "durable queue order must preserve configured request selection");
  mutable.REQUEST_SELECTION_STRATEGY = original.REQUEST_SELECTION_STRATEGY;

  for (const path of ["pending", "fast", "nonpending"] as const) {
    rule = await setup({ role: "worker", shadow: true, acceptAll: path === "fast" });
    await fencePublication({ teamId: 1, epoch, pollerNodeId: nodeId });
    const fencedShadow = makePoller([rule], path === "nonpending" ? [] : [request(201, 1)], path === "nonpending" ? [request(202, 4)] : []);
    assert.equal(await fencedShadow.process(), false, `epoch-bound ${path} shadow must not fall back inline after a fence`);
    assert.ok(!fencedShadow.events.some((event) => event.startsWith("accept")));
    assert.equal(jobs().length, 0);
  }

  rule = await setup({ role: "worker", controlled: false, pendingCutover: true });
  const supervised = makePoller([rule], [request(106, 1)]);
  assert.equal(await supervised.process(), true);
  assert.deepEqual(supervised.events, ["pending"]);
  assert.equal(jobs().length, 1, "explicit supervised cutover works when shadow is disabled");

  for (const shadow of [false, true]) {
    rule = await setup({ role: "worker", controlled: false, shadow, pendingCutover: true, allowTeam: 2 });
    const legacy = makePoller([rule], [request(shadow ? 108 : 107, 1)]);
    await legacy.process();
    assert.ok(legacy.events.includes("accept"), "unselected legacy teams keep inline acceptance");
    assert.equal(jobs().length, shadow ? 1 : 0, "shadow publication must not replace legacy execution");
    await awaitAutoAcceptVerificationIdle();
  }

  rule = await setup({ role: "worker", controlled: false, shadow: true });
  const admission = makePoller([rule], [request(301, 1)]);
  const inlineApi = (admission.poller as unknown as { apiClient: ApiClient }).apiClient;
  const inlineAccept = inlineApi.acceptBookingRequests.bind(inlineApi);
  const workerProviderCalls: string[] = [];
  let workerPreparationDelta = -1;
  let workerClaimed = 0;
  inlineApi.acceptBookingRequests = async (...args) => {
    const sqlite = getRawMemoryDb();
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM auto_accept_attempts").get() as { n: number };
    const result = await runAutoAcceptJobRealExecutionBatch({
      ownerNodeId: "concurrent-real-worker", teamIds: [1], limit: 10, leaseMs: 60_000,
      loadRuleState: () => ({ need: 2, accept_all: false, enabled: true, fulfilled: false }),
      apiClient: {
        acceptBookingRequests: async () => { workerProviderCalls.push("accept"); return { ok: true, httpStatus: 200, response: { retcode: 0 } }; },
        fetchBookingRequestList: async (_id, options) => { workerProviderCalls.push("verify"); return { data: { request_list: options?.tabPendingConfirmation === false ? [request(301, 2)] : [] } }; },
      },
    });
    workerClaimed = result.claimed;
    const after = sqlite.prepare("SELECT COUNT(*) AS n FROM auto_accept_attempts").get() as { n: number };
    workerPreparationDelta = after.n - before.n;
    return inlineAccept(...args);
  };
  await admission.process();
  assert.equal(workerClaimed, 1, "regression must reach real execution with the actual Poller shadow row");
  assert.deepEqual(workerProviderCalls, [], "a concurrent enabled real worker must never execute Poller shadow observations");
  assert.equal(workerPreparationDelta, 0, "shadow admission must stop before durable external-attempt preparation");
  await awaitAutoAcceptVerificationIdle();
  assert.equal(JSON.parse(jobs()[0].payload_json).executionMode, "shadow");
  mutable.AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED = true;
  mutable.AUTO_ACCEPT_JOB_SHADOW_ENABLED = false;
  const transitioned = makePoller([rule], [request(301, 1)]);
  assert.equal(await transitioned.process(), true);
  assert.equal(jobs().length, 2, "intentional cutover must not silently reuse the existing shadow identity");
  const admitted = jobs().find((job) => JSON.parse(job.payload_json).executionMode === "cutover");
  assert.ok(admitted);
  assert.notEqual(admitted.idempotency_key, jobs()[0].idempotency_key);
  assert.ok(!admitted.idempotency_key.startsWith("shadow:"), "executable jobs preserve the canonical identity namespace");

  rule = await setup();
  const lifecycle = makePoller([rule], [], [], false);
  const sqlite = getRawMemoryDb();
  const prepare = sqlite.prepare;
  const verificationReads: string[] = [];
  sqlite.prepare = function (sql: string) {
    if (sql.includes("auto_accept_verification_jobs")) verificationReads.push(sql);
    return prepare.call(this, sql);
  } as typeof sqlite.prepare;
  try {
    await lifecycle.poller.start();
    await fencePublication({ teamId: 1, epoch, pollerNodeId: nodeId });
    await (lifecycle.poller as unknown as { tick(): Promise<void> }).tick();
    await lifecycle.poller.stop();
  }
  finally { sqlite.prepare = prepare; }
  assert.equal(verificationReads.length, 0, "dedicated poller must never acquire legacy verification ownership during lifecycle");
  const idleControl = (await getPublicationControlHistory(1))[0];
  assert.equal(idleControl.ackNodeId, nodeId, "idle ticks acknowledge fences without waiting for a new candidate");
  assert.equal(idleControl.ackJobId, 0);
  console.log("poller job cutover integration passed");
}

main().finally(async () => {
  for (const poller of pollers) await poller.stop();
  await closePool();
  Object.assign(mutable, original);
}).catch((error) => { console.error(error); process.exitCode = 1; });
