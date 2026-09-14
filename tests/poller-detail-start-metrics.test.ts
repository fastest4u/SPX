import assert from "node:assert/strict";
import { test } from "node:test";
import { Poller } from "../src/controllers/poller.js";
import { MetricsCollector } from "../src/services/metrics.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { Booking } from "../src/models/types.js";
import { env } from "../src/config/env.js";
import { createRule, type NotifyRule } from "../src/services/notify-rules.js";
import { NeedBudget } from "../src/services/notifier.js";
import { closePool } from "../src/db/client.js";
import { getRawMemoryDb } from "../src/db/client-memory.js";

type Inner = {
  rateLimitPausedUntil: number;
  tickAutoAcceptRules: NotifyRule[];
  tickNeedBudget: NeedBudget;
  detailInflight: number;
  detailLaunchDelay(): Promise<void>;
  schedulePreparedBookingDetails(bookings: Booking[], options: { firstPageObservedAtMs: number }): Promise<void>;
};
const booking = { booking_id: 910, booking_name: "[ADHOC] A > B 2026-09-12", agency_name: "SPX" } as Booking;

test("page-one timing reaches the real detail boundary after cooldown", async () => {
  const saved = { ...env };
  const metrics = new MetricsCollector({ teamId: 91 });
  const launches: number[] = [];
  const apiClient = {
    fetchBookingRequestList: async () => {
      launches.push(Date.now());
      return { retcode: 0, message: "", data: { pageno: 1, count: 0, total: 0, request_list: [] } };
    },
  } as unknown as ApiClient;
  Object.assign(env, { AUTO_ACCEPT_ENABLED: false, SAVE_TO_DB: false, HTTP_ENABLED: false, BOOKING_REPROCESS_COOLDOWN_MS: 0 });
  const poller = new Poller(undefined, { teamId: 91, metricsCollector: metrics, apiClient, manageHttpServer: false, manageProcessSignals: false, closeSharedResourcesOnStop: false, exitOnStop: false });
  const inner = poller as unknown as Inner;
  try {
    const origin = Date.now();
    inner.detailLaunchDelay = async () => { inner.rateLimitPausedUntil = Date.now() + 80; };
    await inner.schedulePreparedBookingDetails([booking, { ...booking, booking_id: 911 }], { firstPageObservedAtMs: origin });
    while (inner.detailInflight > 0) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches.length, 2);
    const summary = metrics.snapshot().operations.page1ToDetailStart;
    assert.equal(summary.count, 2);
    assert.ok(summary.lastMs! >= 70, `cooldown must be included, observed ${summary.lastMs} ms`);
    assert.ok(Math.abs(summary.lastMs! - (launches[1] - origin)) <= 5, "interval ends at actual detail invocation");
    console.log(JSON.stringify({ scenario: "synthetic delayed detail", observedMs: summary.lastMs, actualLaunchMs: launches[1] - origin }));
  } finally {
    await poller.stop();
    Object.assign(env, saved);
    await closePool();
  }
});

test("real fast accept-all publication returns without a fictitious detail sample", async () => {
  const saved = { ...env };
  Object.assign(env, { AUTO_ACCEPT_ENABLED: true, SAVE_TO_DB: false, HTTP_ENABLED: false, SPX_ROLE: "worker", AUTO_ACCEPT_JOB_CUTOVER_EPOCH: "", AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED: true, AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS: [92], AUTO_ACCEPT_JOB_SHADOW_ENABLED: true, BOOKING_REPROCESS_COOLDOWN_MS: 0 });
  const metrics = new MetricsCollector({ teamId: 92 });
  let reads = 0;
  let posts = 0;
  const apiClient = {
    fetchBookingRequestList: async () => { reads++; throw new Error("unexpected detail"); },
    acceptAllBookingRequests: async () => { posts++; throw new Error("unexpected POST"); },
  } as unknown as ApiClient;
  const poller = new Poller(undefined, { teamId: 92, metricsCollector: metrics, apiClient, manageHttpServer: false, manageProcessSignals: false, closeSharedResourcesOnStop: false, exitOnStop: false });
  const inner = poller as unknown as Inner;
  try {
    inner.tickAutoAcceptRules = [await createRule(92, { name: "Synthetic fast", origins: ["A"], destinations: ["B"], vehicle_types: ["6WH"], need: 2, enabled: true, accept_all: true })];
    await inner.schedulePreparedBookingDetails([booking], { firstPageObservedAtMs: Date.now() });
    while (inner.detailInflight > 0) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(reads, 0);
    assert.equal(posts, 0);
    assert.equal(getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM auto_accept_jobs WHERE team_id = 92").get()!.n, 1, "real queued parent was produced");
    assert.equal(metrics.snapshot().operations.page1ToDetailStart.count, 0);

    // Shadow publication also takes the real fast return when the tick budget is exhausted.
    env.AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED = false;
    const rule = inner.tickAutoAcceptRules[0];
    inner.tickNeedBudget = new NeedBudget();
    assert.equal(inner.tickNeedBudget.claim(rule.id, 2, 2).granted, 2);
    await inner.schedulePreparedBookingDetails([{ ...booking, booking_id: 912 }], { firstPageObservedAtMs: Date.now() });
    while (inner.detailInflight > 0) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getRawMemoryDb().prepare("SELECT COUNT(*) AS n FROM auto_accept_jobs WHERE team_id = 92").get()!.n, 2, "shadow parent is published without replaying provider acceptance");
    assert.equal(reads, 0);
    assert.equal(posts, 0);
    assert.equal(metrics.snapshot().operations.page1ToDetailStart.count, 0);
  } finally {
    await poller.stop();
    Object.assign(env, saved);
    await closePool();
  }
});
