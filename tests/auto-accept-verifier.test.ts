import assert from "node:assert/strict";
import type { ApiClient } from "../src/services/api-client.js";
import { buildAutoAcceptFailureAlertText } from "../src/services/auto-accept-diagnostics.js";
import { verifyAutoAcceptJob, type AutoAcceptVerificationJob } from "../src/services/auto-accept-verifier.js";

function requestListResponse(requests: Array<{ request_id: number; booking_id: number; request_acceptance_status: number; remark?: string }>) {
  return {
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: requests.length,
      total: requests.length,
      request_list: requests,
    },
  };
}

function baseJob(overrides: Partial<AutoAcceptVerificationJob> = {}): AutoAcceptVerificationJob {
  return {
    teamId: 1,
    ruleId: "rule-verifier",
    ruleName: "Verifier Rule",
    bookingId: 2706815,
    requestIds: [38659805],
    trips: [],
    claimToken: 1,
    acceptResult: {
      ok: true,
      httpStatus: 200,
      retcode: 0,
      message: "success",
    },
    acceptStartedAt: 1782545400000,
    acceptFinishedAt: 1782545400084,
    acceptRttMs: 84,
    listAgeMs: 231,
    ambiguousAccept: false,
    acceptAll: false,
    traceId: "aa:1:2706815:38659805:1782545400000",
    ...overrides,
  };
}

async function main(): Promise<void> {
  {
    const tabReads: boolean[] = [];
    const apiClient = {
      fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
        tabReads.push(options?.tabPendingConfirmation !== false);
        return options?.tabPendingConfirmation === false
          ? requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 2 }])
          : requestListResponse([]);
      },
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob());

    assert.deepEqual(tabReads, [true, false]);
    assert.equal(outcome.verificationStatus, "verified_success");
    assert.deepEqual(outcome.acceptedRequestIds, [38659805]);
    assert.deepEqual(outcome.failedRequestIds, []);
    assert.equal(outcome.evidence.pendingTabRead, true);
    assert.equal(outcome.evidence.confirmedTabRead, true);
    assert.equal(outcome.evidence.acceptRttMs, 84);
    assert.equal(outcome.evidence.listAgeMs, 231);
  }

  {
    const apiClient = {
      fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
        return options?.tabPendingConfirmation === false
          ? requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 6 }])
          : requestListResponse([]);
      },
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob());

    assert.equal(outcome.verificationStatus, "verified_failed");
    assert.deepEqual(outcome.acceptedRequestIds, []);
    assert.deepEqual(outcome.failedRequestIds, [38659805]);
    assert.equal(outcome.requests[0]?.reason, "verify_not_confirmed");
  }

  {
    const apiClient = {
      fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
        return options?.tabPendingConfirmation === false
          ? requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 4, remark: "Other agency accept first." }])
          : requestListResponse([]);
      },
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob());

    assert.equal(outcome.verificationStatus, "verified_failed");
    assert.equal(outcome.requests[0]?.reason, "lost_race");
    assert.equal(outcome.requests[0]?.terminal, true);
    assert.equal(outcome.requests[0]?.releaseBudget, true);
    assert.equal(outcome.requests[0]?.releaseRequestDedupe, false);
  }

  {
    const apiClient = {
      fetchBookingRequestList: async () => null,
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob());

    assert.equal(outcome.verificationStatus, "indeterminate");
    assert.deepEqual(outcome.indeterminateRequestIds, [38659805]);
    assert.equal(outcome.requests[0]?.reason, "verify_indeterminate");
    assert.equal(outcome.requests[0]?.terminal, false);
    assert.equal(outcome.requests[0]?.releaseBudget, false);
    assert.equal(outcome.requests[0]?.releaseRequestDedupe, true);
    assert.equal(outcome.evidence.pendingTabRead, false);
    assert.equal(outcome.evidence.confirmedTabRead, false);
  }

  {
    let fetchCalls = 0;
    const apiClient = {
      fetchBookingRequestList: async () => {
        fetchCalls += 1;
        return fetchCalls <= 2
          ? requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 1 }])
          : requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 2 }]);
      },
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob({
      acceptResult: { ok: false, httpStatus: 0, error: "timeout after 10000ms" },
      ambiguousAccept: true,
    }), { ambiguousRecheckDelayMs: 1 });

    assert.equal(fetchCalls, 4, "ambiguous accept should read both tabs, delay, then read both tabs again");
    assert.equal(outcome.verificationStatus, "verified_success");
    assert.deepEqual(outcome.acceptedRequestIds, [38659805]);
  }

  {
    let fetchCalls = 0;
    const apiClient = {
      fetchBookingRequestList: async () => {
        fetchCalls += 1;
        return requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 1 }]);
      },
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob({
      acceptResult: { ok: false, httpStatus: 0, error: "timeout after 10000ms" },
      ambiguousAccept: true,
    }), { ambiguousRecheckDelayMs: 1 });

    assert.equal(fetchCalls, 4);
    assert.equal(outcome.verificationStatus, "indeterminate");
    assert.equal(outcome.requests[0]?.reason, "accept_timeout_ambiguous");
    assert.equal(outcome.requests[0]?.releaseBudget, false);
  }

  {
    const apiClient = {
      fetchBookingRequestList: async () => requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 1 }]),
    } as unknown as ApiClient;

    const outcome = await verifyAutoAcceptJob(apiClient, baseJob({
      acceptResult: { ok: false, httpStatus: 401, error: "session expired" },
    }));

    assert.equal(outcome.verificationStatus, "verified_failed");
    assert.equal(outcome.requests[0]?.reason, "session_expired");
    assert.equal(outcome.requests[0]?.releaseBudget, true);
    assert.equal(outcome.requests[0]?.releaseRequestDedupe, true);
  }

  {
    const text = buildAutoAcceptFailureAlertText({
      now: new Date("2026-06-27T07:30:00.000Z"),
      failures: [{
        bookingId: 2706815,
        requestIds: [38659805],
        ruleName: "Verifier Rule",
        route: "NORC-B -> SOCE",
        vehicleType: "6WH",
        reason: "lost_race",
        error: "Other agency accepted first",
        traceId: "aa:1:2706815:38659805:1782545400000",
        acceptRttMs: 84,
        listAgeMs: 231,
        pendingTabRead: true,
        confirmedTabRead: true,
        nextAction: "Check accept RTT and list age.",
      }],
    });

    assert.match(text, /lost_race/);
    assert.match(text, /2706815/);
    assert.match(text, /38659805/);
    assert.match(text, /acceptRttMs=84/);
    assert.match(text, /listAgeMs=231/);
    assert.match(text, /pending=read/);
    assert.match(text, /confirmed=read/);
    assert.match(text, /aa:1:2706815/);
    assert.match(text, /Check accept RTT/);
  }

  console.log("auto-accept-verifier: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
