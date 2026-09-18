import assert from "node:assert/strict";
import { test } from "node:test";
import { Poller } from "../src/controllers/poller.js";
import { ApiClient } from "../src/services/api-client.js";
import { env } from "../src/config/env.js";
import type { Booking } from "../src/models/types.js";
import { pauseTeam, resumeTeam } from "../src/services/poller-control.js";

const booking = (id: number) => ({ booking_id: id, booking_name: `[ADHOC] ${id}`, agency_name: "SPX" }) as Booking;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
type Internals = {
  tick(): Promise<void>;
  prepareBookingDetailTick(): Promise<void>;
  detailLaunchDelay(): Promise<void>;
  tickNeedBudget: { beginTick(): void };
  processOneBooking(item: Booking): Promise<boolean>;
  listFreshnessPrimed: boolean;
  pendingFastLaneBookingIds: Set<number>;
  activeDetailBookingIds: Set<number>;
  detailInflight: number;
  dataProcessor: { detectChange: (...args: unknown[]) => unknown };
};
async function fixture(run: (p: Poller, inner: Internals, events: string[], gate: ReturnType<typeof deferred>, requested: ReturnType<typeof deferred>) => Promise<void>) {
  const saved = { ...env }; const savedFetch = globalThis.fetch;
  Object.assign(env, { API_URL: "https://spx.example.test/booking/bidding/list", SPX_ROLE: "monolith", FETCH_DETAILS: true, SAVE_TO_DB: false, AUTO_ACCEPT_ENABLED: false, HTTP_ENABLED: true, BOOKING_DETAIL_CONCURRENCY: 8, BOOKING_REPROCESS_COOLDOWN_MS: 0, BIDDING_LIST_FETCH_EXTRA_PAGES: true });
  const events: string[] = []; const gate = deferred(); const requested = deferred();
  globalThis.fetch = async (_url, init) => {
    const pageno = JSON.parse(String(init?.body)).pageno;
    if (pageno === 2) { requested.resolve(); await gate.promise; }
    return new Response(JSON.stringify({ retcode: 0, message: "", data: { pageno, count: 2, total: 4, list: pageno === 1 ? [booking(1), booking(2)] : [booking(3), booking(4)] } }));
  };
  const p = new Poller(undefined, { teamId: 1, teamName: "synthetic", lineGroupId: "", apiClient: new ApiClient({ pollIntervalMsProvider: () => 150 }), manageHttpServer: false, manageProcessSignals: false, closeSharedResourcesOnStop: false, exitOnStop: false, realtimePublisher: { publish: async () => {} } as never });
  const inner = p as unknown as Internals;
  inner.processOneBooking = async (item) => { events.push(`detail:${item.booking_id}`); return true; };
  inner.detailLaunchDelay = async () => { events.push("delay"); };
  try { await run(p, inner, events, gate, requested); } finally { gate.resolve(); await p.stop(); resumeTeam(1); globalThis.fetch = savedFetch; Object.assign(env, saved); }
}

test("actual poller starts page-one details before page two, prepares once and primes only complete list", async () => fixture(async (_p, inner, events, gate, requested) => {
  let seeds = 0;
  let preparations = 0;
  const prepare = inner.prepareBookingDetailTick.bind(inner);
  inner.prepareBookingDetailTick = async () => { preparations++; await prepare(); };
  const aggregates: number[] = [];
  const detect = inner.dataProcessor.detectChange.bind(inner.dataProcessor);
  inner.dataProcessor.detectChange = (...args) => {
    aggregates.push((args[0] as { data: { list: Booking[] } }).data.list.length);
    return detect(...args);
  };
  const begin = inner.tickNeedBudget.beginTick.bind(inner.tickNeedBudget);
  inner.tickNeedBudget.beginTick = () => { seeds++; begin(); };
  let finished = false; const tick = inner.tick().then(() => { finished = true; });
  try {
    await requested.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.includes("detail:1"), "page-1 detail must start while page2 is gated");
    assert.equal(finished, false);
    assert.equal(inner.listFreshnessPrimed, false);
  } finally { gate.resolve(); await tick; }
  assert.equal(seeds, 1, "partial and full batches share one budget/rules preparation");
  assert.equal(preparations, 1);
  assert.deepEqual(aggregates, [4], "change detection receives only the complete list");
  assert.equal(inner.listFreshnessPrimed, true);
  assert.deepEqual(events.filter((event) => event.startsWith("detail:")), ["detail:1", "detail:2", "detail:3", "detail:4"], "completed page-one jobs must not repeat even with cooldown disabled");
  assert.equal(inner.pendingFastLaneBookingIds.size, 0);
  assert.equal(events.filter((event) => event === "delay").length, 3, "background pacing is retained across the partial/full batch boundary");
}));

test("primed arrivals skip stagger while recurring background launches retain it", async () => fixture(async (_p, inner, events, gate) => {
  gate.resolve(); await inner.tick(); events.length = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ retcode: 0, message: "", data: { pageno: 1, count: 4, total: 4, list: [booking(5), booking(6), booking(1), booking(2)] } }));
  await inner.tick();
  assert.deepEqual(events, ["detail:5", "detail:6", "delay", "detail:1", "delay", "detail:2"]);
}));

test("stop during pending preparation prevents all deferred launches", async () => fixture(async (p, inner, events, gate, requested) => {
  const preparing = deferred(); const release = deferred();
  inner.prepareBookingDetailTick = async () => { preparing.resolve(); await release.promise; };
  const tick = inner.tick();
  try {
    await requested.promise;
    await Promise.race([preparing.promise, new Promise((resolve) => setTimeout(resolve, 50))]);
    await p.stop();
  } finally { release.resolve(); gate.resolve(); await tick; }
  assert.deepEqual(events, [], "stop fences outstanding preparation and full batch");
}));

test("preparation rejection is handled and prevents later batches", async () => fixture(async (_p, inner, events, gate) => {
  inner.prepareBookingDetailTick = async () => { throw new Error("synthetic preparation failure"); };
  gate.resolve(); await inner.tick();
  assert.deepEqual(events, []);
}));

test("stop or pause during background stagger prevents later business launches", async () => {
  for (const action of ["stop", "pause"]) await fixture(async (p, inner, events, gate) => {
    const delaying = deferred(); const release = deferred();
    inner.detailLaunchDelay = async () => { delaying.resolve(); await release.promise; };
    gate.resolve(); const tick = inner.tick();
    try {
      await delaying.promise;
      if (action === "stop") await p.stop(); else pauseTeam(1);
    } finally { release.resolve(); await tick; }
    assert.deepEqual(events, ["detail:1"]);
    assert.equal(inner.detailInflight, 0);
    assert.equal(inner.activeDetailBookingIds.size, 0);
  });
});

test("failed page two does not repeat first-page work or prime startup", async () => fixture(async (_p, inner, events, gate) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => JSON.parse(String(init?.body)).pageno === 2
    ? new Response("synthetic page-two failure", { status: 400 }) : original(url, init);
  gate.resolve(); await inner.tick();
  assert.deepEqual(events.filter((event) => event.startsWith("detail:")), ["detail:1", "detail:2"]);
  assert.equal(inner.listFreshnessPrimed, false);
}));
