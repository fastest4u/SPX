import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "../src/services/api-client.js";
import { env } from "../src/config/env.js";
import type { ApiResponse } from "../src/models/types.js";

const page = (pageno = 1, total = 2) => ({ retcode: 0, message: "", data: { pageno, count: 1, total, list: [{ booking_id: pageno }] } });
function fetchList(client: ApiClient, callback: (page: ApiResponse, observed: number) => void) {
  return (client.fetch as (n: number, options: { onFirstPage: typeof callback }) => ReturnType<ApiClient["fetch"]>).call(client, 1, { onFirstPage: callback });
}
async function fixture(run: () => Promise<void>, extraEnv?: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const originalUrl = env.API_URL;
  const originalExtraPages = env.BIDDING_LIST_FETCH_EXTRA_PAGES;
  Object.assign(env, { API_URL: "https://spx.example.test/booking/bidding/list", ...extraEnv });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(env, { API_URL: originalUrl, BIDDING_LIST_FETCH_EXTRA_PAGES: originalExtraPages });
  }
}

test("validated first page is observed before gated aggregate; failed extra page stays unsuccessful", async () => fixture(async () => {
  for (const failed of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pageTwo!: () => void;
    const requested = new Promise<void>((resolve) => { pageTwo = resolve; });
    const observed: number[] = [];
    let finished = false;
    globalThis.fetch = async (_url, init) => {
      const pageno = JSON.parse(String(init?.body)).pageno;
      if (pageno === 2) { pageTwo(); await gate; }
      return new Response(JSON.stringify(page(pageno)), { status: failed && pageno === 2 ? 400 : 200 });
    };
    const pending = fetchList(new ApiClient({ pollIntervalMsProvider: () => 150 }), (value, at) => {
      assert.ok(Number.isFinite(at)); observed.push(value.data.list[0].booking_id);
    }).then((result) => { finished = true; return result; });
    try {
      await requested;
      assert.deepEqual(observed, [1], "callback must precede second-page completion");
      assert.equal(finished, false);
    } finally { release(); await pending; }
    const result = await pending;
    assert.equal(result.success, !failed);
    assert.deepEqual(observed, [1]);
    if (result.success) assert.equal(result.data.data.list.length, 2);
  }
}, { BIDDING_LIST_FETCH_EXTRA_PAGES: true }));

test("bidding list only fetches first page when BIDDING_LIST_FETCH_EXTRA_PAGES is false", async () => fixture(async () => {
  let fetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    fetchCalls++;
    const pageno = JSON.parse(String(init?.body)).pageno;
    assert.equal(pageno, 1, "poller should not request page > 1 when extra pages are disabled");
    return new Response(JSON.stringify(page(1, 100)));
  };
  const result = await new ApiClient({ pollIntervalMsProvider: () => 150 }).fetch(1);
  assert.equal(result.success, true);
  assert.equal(fetchCalls, 1);
  if (result.success) {
    assert.equal(result.data.data.list.length, 1);
  }
}, { BIDDING_LIST_FETCH_EXTRA_PAGES: false }));

test("invalid and rejected first pages never invoke callback", async () => fixture(async () => {
  for (const payload of [{ ...page(1, 1), retcode: 10001 }, { ...page(1, 1), retcode: 130008001 }, { ...page(1, 1), retcode: 42 }, { retcode: 0, message: "", data: {} }]) {
    globalThis.fetch = async () => new Response(JSON.stringify(payload));
    let callbacks = 0;
    const result = await fetchList(new ApiClient({ pollIntervalMsProvider: () => 150 }), () => { callbacks++; });
    assert.equal(result.success, false);
    assert.equal(callbacks, 0);
  }
}));

test("discarded retry bodies are cancelled before retry, including cancellation rejection", async () => fixture(async () => {
  for (const rejects of [false, true]) {
    let cancelled = false;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; if (rejects) throw new Error("synthetic private body failure"); } }), { status: 503, headers: { "Retry-After": "1" } });
      assert.equal(cancelled, true, "body must be cancelled before retry dispatch");
      return new Response(JSON.stringify(page(1, 1)));
    };
    const result = await new ApiClient({ pollIntervalMsProvider: () => 3_000 }).fetch(1);
    assert.equal(result.success, true);
    assert.equal(calls, 2);
  }
}));

test("terminal responses remain readable", async () => fixture(async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("terminal synthetic error")); controller.close(); },
    cancel() { cancelled = true; },
  }), { status: 503 });
  const result = await new ApiClient({ pollIntervalMsProvider: () => 150 }).fetch(1);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error ?? "", /terminal synthetic error/);
  assert.equal(cancelled, false);
}));

test("a pending cancellation cannot extend the existing retry wait indefinitely", { timeout: 3_000 }, async () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 503, headers: { "Retry-After": "1" } })
    : new Response(JSON.stringify(page(1, 1)));
  const result = await new ApiClient({ pollIntervalMsProvider: () => 3_000 }).fetch(1);
  assert.equal(result.success, true);
  assert.equal(calls, 2);
}));
