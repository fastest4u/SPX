import assert from "node:assert/strict";
import { ApiClient } from "../src/services/api-client.js";
import { env } from "../src/config/env.js";

const mutableEnv = env as unknown as {
  API_URL: string;
  BIDDING_PAGE_NO: number;
  BIDDING_PAGE_COUNT: number;
  REQUEST_TAB_PENDING_CONFIRMATION: boolean;
  REQUEST_CTIME_START: number;
};

const originalEnv = {
  API_URL: mutableEnv.API_URL,
  BIDDING_PAGE_NO: mutableEnv.BIDDING_PAGE_NO,
  BIDDING_PAGE_COUNT: mutableEnv.BIDDING_PAGE_COUNT,
  REQUEST_TAB_PENDING_CONFIRMATION: mutableEnv.REQUEST_TAB_PENDING_CONFIRMATION,
  REQUEST_CTIME_START: mutableEnv.REQUEST_CTIME_START,
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function overview(id: number): Response {
  return json({ retcode: 0, message: "", data: { id, vehicle_driver_info: [] } });
}

function successfulList(): Response {
  return json({ retcode: 0, message: "", data: { pageno: 1, count: 100, total: 0, list: [] } });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for API request");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  Object.assign(mutableEnv, {
    API_URL: "https://spx.example.test/booking/bidding/list",
    BIDDING_PAGE_NO: 1,

    BIDDING_PAGE_COUNT: 100,
    REQUEST_TAB_PENDING_CONFIRMATION: true,
    REQUEST_CTIME_START: 0,
  });

  try {
    {
      let fetchCalls = 0;
      globalThis.fetch = async (input) => {
        fetchCalls += 1;
        if (String(input).includes("booking_overview")) return overview(10);
        return json({ retcode: 0, message: "limited", data: { list: [] } }, {
          status: 429,
          headers: { "retry-after": "1" },
        });
      };

      const client = new ApiClient({ pollIntervalMsProvider: () => 100 });
      const result = await client.fetch(1);
      assert.equal(result.success, false);
      assert.ok(client.getRateLimitRetryAt() > Date.now());

      const blockedRead = client.fetchBookingOverview(10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fetchCalls, 1, "HTTP 429 cooldown must suppress all later reads on the client");
      await blockedRead;
    }

    {
      let firstClientCalls = 0;
      let secondClientCalls = 0;
      globalThis.fetch = async (_input, init) => {
        const deviceId = new Headers(init?.headers).get("device-id");
        if (deviceId === "first-device") {
          firstClientCalls += 1;
          return json({ retcode: 130008001, message: "rate limited", data: { list: [] } }, {
            headers: { "retry-after": "1" },
          });
        }
        secondClientCalls += 1;
        return successfulList();
      };

      const first = new ApiClient({
        credentials: { spxCookie: "first-cookie", spxDeviceId: "first-device" },
        pollIntervalMsProvider: () => 100,
      });
      const second = new ApiClient({
        credentials: { spxCookie: "second-cookie", spxDeviceId: "second-device" },
        pollIntervalMsProvider: () => 100,
      });
      const limited = await first.fetch(1);
      assert.equal(limited.success, false);
      if (!limited.success) assert.equal(limited.retcode, 130008001);
      assert.ok(first.getRateLimitRetryAt() > Date.now());

      const blockedFirstRead = first.fetchBookingOverview(11);
      await second.fetch(2);
      assert.equal(firstClientCalls, 1, "business rate limit must cool down later reads");
      assert.equal(secondClientCalls, 1, "a second ApiClient must not inherit the cooldown");
      await blockedFirstRead;
    }

    {
      globalThis.fetch = async () => json({ retcode: 0, message: "limited", data: { list: [] } }, {
        status: 429,
        headers: { "retry-after": "120" },
      });
      const client = new ApiClient({ pollIntervalMsProvider: () => 100 });
      const before = Date.now();
      await client.fetch(5);
      assert.ok(
        client.getRateLimitRetryAt() >= before + 120_000,
        "shared cooldown must retain the full valid Retry-After deadline",
      );
    }

    {
      const firstGate = deferred();
      const secondGate = deferred();
      const started: number[] = [];
      globalThis.fetch = async (input) => {
        const id = Number(new URL(String(input)).searchParams.get("id"));
        started.push(id);
        if (id === 1) await firstGate.promise;
        if (id === 2) await secondGate.promise;
        return overview(id);
      };

      const client = new ApiClient({ credentials: { spxCookie: "cookie", spxDeviceId: "device" } });
      const first = client.fetchBookingOverview(1);
      const second = client.fetchBookingOverview(2);
      await waitFor(() => started.length === 2);
      const detail = client.fetchBookingOverview(3);
      const verification = client.withVerificationPriority(() => client.fetchBookingOverview(4));

      firstGate.resolve();
      await waitFor(() => started.length >= 3);
      assert.deepEqual(started.slice(0, 3), [1, 2, 4], "queued verification must start before queued detail");
      secondGate.resolve();
      await Promise.all([first, second, detail, verification]);
    }

    {
      let acceptCalls = 0;
      globalThis.fetch = async (input) => {
        if (String(input).endsWith("/accept")) {
          acceptCalls += 1;
          return json({ retcode: 130008001, message: "limited", data: null }, { status: 429 });
        }
        return json({ retcode: 130008001, message: "limited", data: { list: [] } }, {
          headers: { "retry-after": "1" },
        });
      };

      const client = new ApiClient({
        credentials: { spxCookie: "cookie", spxDeviceId: "device" },
        pollIntervalMsProvider: () => 100,
      });
      await client.fetch(3);
      const accept = client.acceptBookingRequests(15, [20]);
      const completedDuringCooldown = await Promise.race([
        accept.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      assert.equal(completedDuringCooldown, true, "read cooldown must not delay an accept POST");
      const result = await accept;
      assert.equal(result.ok, false);
      assert.equal(acceptCalls, 1, "accept POST must never be replayed after HTTP 429");
    }

    {
      let verificationAllowed = true;
      let fetchCalls = 0;
      globalThis.fetch = async (input) => {
        fetchCalls += 1;
        if (String(input).includes("booking_overview")) return overview(30);
        return json({ retcode: 130008001, message: "limited", data: { list: [] } }, {
          headers: { "retry-after": "1" },
        });
      };

      const client = new ApiClient({
        credentials: { spxCookie: "cookie", spxDeviceId: "device" },
        pollIntervalMsProvider: () => 100,
      });
      await client.fetch(4);
      const guarded = client.withVerificationPriority(
        () => client.fetchBookingOverview(30),
        () => verificationAllowed,
      );
      verificationAllowed = false;

      assert.equal(await guarded, null);
      assert.equal(fetchCalls, 1, "a verification guard closed during cooldown must suppress dispatch");
    }

    {
      let verificationAllowed = true;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        verificationAllowed = false;
        return json({ retcode: 500, message: "temporary", data: null }, { status: 500 });
      };

      const client = new ApiClient({ credentials: { spxCookie: "cookie", spxDeviceId: "device" } });
      const result = await client.withVerificationPriority(
        () => client.fetchBookingOverview(31),
        () => verificationAllowed,
      );
      assert.equal(result, null);
      assert.equal(fetchCalls, 1, "a guard closed after an attempt must suppress its retry");
    }

    {
      let verificationAllowed = true;
      let fetchCalls = 0;
      globalThis.fetch = async (_input, init) => {
        fetchCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { pageno?: number };
        return json({
          retcode: 0,
          message: "",
          data: {
            pageno: body.pageno ?? 1,
            count: 100,
            total: 200,
            request_list: [{ request_id: body.pageno ?? 1, booking_id: 32 }],
          },
        });
      };

      const client = new ApiClient({ credentials: { spxCookie: "cookie", spxDeviceId: "device" } });
      const result = await client.withVerificationPriority(
        () => client.fetchBookingRequestList(32, {
          onPage: () => { verificationAllowed = false; },
        }),
        () => verificationAllowed,
      );
      assert.equal(result, null);
      assert.equal(fetchCalls, 1, "a guard closed after page one must suppress later pagination");
    }


    {
      let acceptCalls = 0;
      globalThis.fetch = async () => {
        acceptCalls += 1;
        return json({ retcode: 130008001, message: "limited", data: null }, {
          status: 429,
          headers: { "retry-after": "120" },
        });
      };
      const client = new ApiClient({ credentials: { spxCookie: "cookie", spxDeviceId: "device" } });
      const before = Date.now();
      const result = await client.acceptBookingRequests(40, [41]);
      assert.equal(result.ok, false);
      assert.equal(acceptCalls, 1, "rate-limited accept POST must remain single-attempt");
      assert.ok(
        client.getRateLimitRetryAt() >= before + 120_000,
        "HTTP 429 accept response must extend the shared read cooldown",
      );
    }

    {
      let acceptCalls = 0;
      globalThis.fetch = async () => {
        acceptCalls += 1;
        return json({ retcode: 130008001, message: "limited", data: null });
      };
      const client = new ApiClient({ credentials: { spxCookie: "cookie", spxDeviceId: "device" } });
      const before = Date.now();
      const result = await client.acceptBookingRequests(42, [43]);
      assert.equal(result.ok, false);
      assert.equal(acceptCalls, 1, "business-limited accept POST must remain single-attempt");
      assert.ok(
        client.getRateLimitRetryAt() >= before + 1_000,
        "business rate-limit accept response must extend the shared read cooldown",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(mutableEnv, originalEnv);
  }

  console.log("api-client-read-scheduler: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
