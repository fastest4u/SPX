import assert from "node:assert/strict";
import {
  ApiClient,
  buildBiddingListBody,
  listPollRetries,
  listPollTimeoutMs,
  normalizeApiResponse,
} from "../src/services/api-client.js";
import { classifyPollingError } from "../src/utils/error-classifier.js";
import { env } from "../src/config/env.js";

const mutableEnv = env as unknown as {
  BIDDING_PAGE_NO: number;
  BIDDING_PAGE_COUNT: number;
  REQUEST_TAB_PENDING_CONFIRMATION: boolean;
  REQUEST_CTIME_START: number;
  BIDDING_VEHICLE_TYPE?: number;
  API_URL: string;
  COOKIE: string;
  DEVICE_ID: string;
  APP_NAME: string;
  REFERER: string;
};

const original = {
  BIDDING_PAGE_NO: mutableEnv.BIDDING_PAGE_NO,
  BIDDING_PAGE_COUNT: mutableEnv.BIDDING_PAGE_COUNT,
  REQUEST_TAB_PENDING_CONFIRMATION: mutableEnv.REQUEST_TAB_PENDING_CONFIRMATION,
  REQUEST_CTIME_START: mutableEnv.REQUEST_CTIME_START,
  BIDDING_VEHICLE_TYPE: mutableEnv.BIDDING_VEHICLE_TYPE,
  API_URL: mutableEnv.API_URL,
  COOKIE: mutableEnv.COOKIE,
  DEVICE_ID: mutableEnv.DEVICE_ID,
  APP_NAME: mutableEnv.APP_NAME,
  REFERER: mutableEnv.REFERER,
};

async function main(): Promise<void> {
  // Adaptive poll cadence math: fail-fast retry budget at aggressive
  // intervals, unchanged behavior at the default 30s interval.
  assert.equal(listPollRetries(30_000), 3, "default interval keeps full retries");
  assert.equal(listPollRetries(3_000), 1, "tight interval grants only what fits half the interval");
  assert.equal(listPollRetries(150), 0, "aggressive interval never retries in-tick");
  assert.equal(listPollRetries(0), 3, "non-positive interval falls back to MAX_RETRIES");
  assert.equal(listPollRetries(Number.NaN), 3, "non-finite interval falls back to MAX_RETRIES");
  assert.equal(listPollTimeoutMs(150), 5_000, "timeout floor protects slow-but-healthy responses");
  assert.equal(listPollTimeoutMs(4_000), 8_000, "timeout tracks ~2x interval in the adaptive band");
  assert.equal(listPollTimeoutMs(30_000), 15_000, "timeout is capped at FETCH_TIMEOUT_MS");
  assert.equal(listPollTimeoutMs(0), 15_000, "non-positive interval falls back to FETCH_TIMEOUT_MS");

  try {
  Object.assign(mutableEnv, {
    BIDDING_PAGE_NO: 1,
    BIDDING_PAGE_COUNT: 100,
    REQUEST_TAB_PENDING_CONFIRMATION: true,
    REQUEST_CTIME_START: 1779469200,
    BIDDING_VEHICLE_TYPE: 13,
  });

  assert.deepEqual(buildBiddingListBody(2), {
    pageno: 2,
    count: 100,
    request_tab_pending_confirmation: true,
    request_ctime_start: 1779469200,
    vehicle_type: 13,
  });

  mutableEnv.BIDDING_VEHICLE_TYPE = undefined;
  assert.deepEqual(buildBiddingListBody(1), {
    pageno: 1,
    count: 100,
    request_tab_pending_confirmation: true,
    request_ctime_start: 1779469200,
  });

  const normalized = normalizeApiResponse({
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: 100,
      total: 0,
      list: [{ booking_id: 2565600 }, { booking_id: 2565558 }],
    },
  });

  assert.equal(normalized?.data.total, 2);
  assert.equal(normalized?.data.list.length, 2);

  const emptyNormalized = normalizeApiResponse({
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: 100,
      total: 0,
      list: null,
    },
  });

  assert.equal(emptyNormalized?.data.total, 0);
  assert.equal(emptyNormalized?.data.list.length, 0);

  Object.assign(mutableEnv, {
    API_URL: "https://spx.example.test/booking/bidding/list",
    COOKIE: "cookie-for-test",
    DEVICE_ID: "device-for-test",
    APP_NAME: "app-for-test",
    REFERER: "https://spx.example.test/dashboard?tab=bidding",
    BIDDING_PAGE_COUNT: 100,
    REQUEST_TAB_PENDING_CONFIRMATION: true,
  });

  const originalFetch = globalThis.fetch;
  let releaseSecondPage!: () => void;
  const secondPageGate = new Promise<void>((resolve) => {
    releaseSecondPage = resolve;
  });
  let firstPageCallback!: () => void;
  const firstPageSeen = new Promise<void>((resolve) => {
    firstPageCallback = resolve;
  });
  let secondPageRequested = false;
  let firstPageHeaders: Record<string, string> | null = null;

  try {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { pageno?: number };
      const pageNo = body.pageno ?? 1;
      if (pageNo === 1) {
        firstPageHeaders = init?.headers as Record<string, string>;
      }

      if (pageNo === 2) {
        secondPageRequested = true;
        await secondPageGate;
      }

      return new Response(JSON.stringify({
        retcode: 0,
        message: "",
        data: {
          pageno: pageNo,
          count: 100,
          total: 200,
          request_list: [{ request_id: pageNo, booking_id: 123 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new ApiClient();
    const fullResult = client.fetchBookingRequestList(123, {
      onPage: (page) => {
        if (page.data.pageno === 1) {
          firstPageCallback();
        }
      },
    });

    const firstPageArrived = await Promise.race([
      firstPageSeen.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(firstPageArrived, true, "first detail page should be observable before later pages finish");
    // The user-agent + origin are REQUIRED: the SGW gateway returns 403 on any
    // request without a user-agent (proven by live A/B test 2026-06-11). These
    // must always be present.
    assert.equal(firstPageHeaders?.origin, "https://spx.example.test");
    assert.match(firstPageHeaders?.["user-agent"] ?? "", /Chrome\/147\.0\.0\.0/);

    const completedBeforeSecondPage = await Promise.race([
      fullResult.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    assert.equal(completedBeforeSecondPage, false, "full detail result should still wait for later pages");
    assert.equal(secondPageRequested, true);

    releaseSecondPage();
    const result = await fullResult;
    assert.equal(result?.data.request_list.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const fetchBeforeFailedExtraPage = globalThis.fetch;
  try {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { pageno?: number };
      const pageNo = body.pageno ?? 1;
      if (pageNo === 2) {
        return new Response(JSON.stringify({ retcode: 500, message: "page failed", data: {} }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        retcode: 0,
        message: "",
        data: {
          pageno: 1,
          count: 100,
          total: 200,
          request_list: [{ request_id: 1, booking_id: 123 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new ApiClient();
    const partialResult = await client.fetchBookingRequestList(123);
    assert.equal(partialResult, null, "extra request-list page failure must mark the full result incomplete");
  } finally {
    globalThis.fetch = fetchBeforeFailedExtraPage;
  }

  const fetchBeforeRequestListRetcode = globalThis.fetch;
  try {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({
        retcode: 500,
        message: "request-list failed",
        data: {
          pageno: 1,
          count: 100,
          total: 1,
          request_list: [{ request_id: 1, booking_id: 123 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });

    const client = new ApiClient();
    const retcodeResult = await client.fetchBookingRequestList(123);
    assert.equal(retcodeResult, null, "request-list retcode!=0 must not be treated as usable detail data");
  } finally {
    globalThis.fetch = fetchBeforeRequestListRetcode;
  }

  const fetchBeforeFailedBiddingExtraPage = globalThis.fetch;
  try {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { pageno?: number };
      const pageNo = body.pageno ?? 1;
      if (pageNo === 2) {
        return new Response(JSON.stringify({ retcode: 500, message: "page failed", data: { list: [] } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        retcode: 0,
        message: "",
        data: {
          pageno: 1,
          count: 100,
          total: 200,
          list: [{ booking_id: 123 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new ApiClient();
    const pollResult = await client.fetch(2);
    assert.equal(pollResult.success, false);
    if (!pollResult.success) {
      assert.match(pollResult.error ?? "", /Incomplete bidding list/);
    }
  } finally {
    globalThis.fetch = fetchBeforeFailedBiddingExtraPage;
  }

  // Session expiry signaled as HTTP 200 + body retcode must surface the
  // retcode on the failure result so the poller's classifier reaches
  // session_expired (alert + dashboard banner path) instead of "unknown".
  const fetchBeforeExpiry = globalThis.fetch;
  try {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ retcode: 10001, message: "session expired", data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const client = new ApiClient();
    const pollResult = await client.fetch(1);
    assert.equal(pollResult.success, false);
    if (!pollResult.success) {
      assert.equal(pollResult.retcode, 10001);
      const classified = classifyPollingError(pollResult.httpStatus, pollResult.error, pollResult.retcode);
      assert.equal(classified.category, "session_expired");
      assert.equal(classified.retryable, false);
    }
  } finally {
    globalThis.fetch = fetchBeforeExpiry;
  }
  } finally {
    Object.assign(mutableEnv, original);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
