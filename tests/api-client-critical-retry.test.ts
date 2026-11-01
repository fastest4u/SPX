import assert from "node:assert/strict";
import { ApiClient } from "../src/services/api-client.js";
import { env } from "../src/config/env.js";

const mutableEnv = env as unknown as {
  API_URL: string;
  BIDDING_PAGE_COUNT: number;
  REQUEST_TAB_PENDING_CONFIRMATION: boolean;
};

const originalEnv = {
  API_URL: mutableEnv.API_URL,
  BIDDING_PAGE_COUNT: mutableEnv.BIDDING_PAGE_COUNT,
  REQUEST_TAB_PENDING_CONFIRMATION: mutableEnv.REQUEST_TAB_PENDING_CONFIRMATION,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function emptyRequestList(): Response {
  return json({ retcode: 0, message: "", data: { pageno: 1, count: 50, total: 0, request_list: [] } });
}

/** First attempt fails with a retryable 503; measures time until the retry lands. */
async function timeRetry(priority: "critical" | undefined): Promise<{ elapsedMs: number; calls: number }> {
  let calls = 0;
  let firstAt = 0;
  let secondAt = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      firstAt = Date.now();
      return json({ retcode: 0, message: "unavailable" }, { status: 503 });
    }
    secondAt = Date.now();
    return emptyRequestList();
  };
  const client = new ApiClient({ pollIntervalMsProvider: () => 800 });
  const result = await client.fetchBookingRequestList(42, priority ? { priority } : {});
  assert.ok(result, "the retried read must succeed");
  return { elapsedMs: secondAt - firstAt, calls };
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  Object.assign(mutableEnv, {
    API_URL: "https://spx.example.test/booking/bidding/list",
    BIDDING_PAGE_COUNT: 50,
    REQUEST_TAB_PENDING_CONFIRMATION: true,
  });

  try {
    const critical = await timeRetry("critical");
    assert.equal(critical.calls, 2);
    assert.ok(critical.elapsedMs < 400, `critical retry must be fast (took ${critical.elapsedMs}ms)`);

    const background = await timeRetry(undefined);
    assert.equal(background.calls, 2);
    assert.ok(background.elapsedMs >= 1000, `background retry keeps the 1s backoff (took ${background.elapsedMs}ms)`);

    {
      // Critical reads are capped at 2 retries even when the caller allows more.
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return json({ retcode: 0, message: "unavailable" }, { status: 503 });
      };
      const client = new ApiClient({ pollIntervalMsProvider: () => 800 });
      const result = await client.fetchBookingRequestList(43, { priority: "critical" });
      assert.equal(result, null);
      assert.equal(calls, 3, "1 attempt + 2 fast retries");
    }

    console.log("api-client-critical-retry: all assertions passed");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(mutableEnv, originalEnv);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
