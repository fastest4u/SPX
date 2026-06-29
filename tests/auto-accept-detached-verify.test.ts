import assert from "node:assert/strict";
import type { PublishEnvelope } from "../src/services/notification-publisher.js";

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-detached-verify-test-key";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  let lastValue: T;
  do {
    lastValue = await read();
    if (done(lastValue)) return lastValue;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const { LogLevel, setLogLevel } = await import("../src/utils/logger.js");
  const teams = await import("../src/repositories/team-repository.js");
  const rules = await import("../src/services/notify-rules.js");
  const { getAutoAcceptHistory } = await import("../src/repositories/auto-accept-repository.js");
  const { getAutoAcceptResult } = await import("../src/repositories/auto-accept-result-repository.js");
  const { createNotificationPublisher } = await import("../src/services/notification-publisher.js");
  const { env } = await import("../src/config/env.js");
  const { acceptAndNotifyMatchedRules, awaitAutoAcceptVerificationIdle, NeedBudget, setWorkerNotificationPublisherForTests } = await import("../src/services/notifier.js");

  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);

  const team = await teams.createTeam({
    name: "Detached Verify Team",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "",
  });

  const successRule = await rules.createRule(team.id, {
    name: "Detached Success",
    origins: ["A"],
    destinations: ["B"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });

  const successTrip = {
    origin: "A",
    destination: "B",
    vehicle_type: "4W",
    booking_id: 2706815,
    request_id: 38659805,
  };

  const verifyGate = deferred();
  let acceptCalls = 0;
  let verifyCalls = 0;
  const apiClient = {
    acceptBookingRequests: async () => {
      acceptCalls += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } };
    },
    fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
      verifyCalls += 1;
      await verifyGate.promise;
      return options?.tabPendingConfirmation === false
        ? requestListResponse([{ request_id: 38659805, booking_id: 2706815, request_acceptance_status: 2 }])
        : requestListResponse([]);
    },
  };

  const resultPromise = acceptAndNotifyMatchedRules([successTrip], apiClient as never, {
    teamId: team.id,
    notificationContext: { teamId: team.id, teamName: team.name, lineGroupId: "" },
    autoAcceptRules: [successRule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    verificationMode: "detached",
  });

  const race = await Promise.race([
    resultPromise.then(() => "resolved"),
    delay(75).then(() => "blocked"),
  ]);

  assert.equal(acceptCalls, 1);
  assert.equal(verifyCalls, 2, "detached worker should have started both-tab verification");
  assert.equal(race, "resolved", "detached mode should not wait for verification fetches");

  const immediateResult = await resultPromise;
  assert.equal(immediateResult.pendingVerification, 1);
  assert.equal(immediateResult.accepted.length, 0);
  assert.equal(immediateResult.failed.length, 0);
  assert.equal(immediateResult.deferredRequests, 0);
  assert.equal(immediateResult.notified, false);

  verifyGate.resolve();
  await awaitAutoAcceptVerificationIdle();

  const successRows = await waitFor(
    () => getAutoAcceptHistory(team.id, { limit: 20 }),
    (rows) => rows.some((row) => row.bookingId === 2706815 && row.status === "success"),
    "detached success history row",
  );
  const successRow = successRows.find((row) => row.bookingId === 2706815);
  assert.deepEqual(successRow?.requestIds, [38659805]);
  assert.equal(successRow?.acceptedCount, 1);
  assert.equal(successRow?.verificationStatus, "verified_success");

  const updatedSuccessRule = (await rules.readRules(team.id)).find((item) => item.id === successRule.id);
  assert.equal(updatedSuccessRule?.need, 0);
  assert.equal(updatedSuccessRule?.auto_accepted, true);

  const lostRaceRule = await rules.createRule(team.id, {
    name: "Detached Lost Race",
    origins: ["C"],
    destinations: ["D"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });

  const lostRaceApiClient = {
    acceptBookingRequests: async () => ({ ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } }),
    fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
      return options?.tabPendingConfirmation === false
        ? requestListResponse([{ request_id: 38659806, booking_id: 2706816, request_acceptance_status: 4, remark: "Other agency accept first." }])
        : requestListResponse([]);
    },
  };

  const lostRaceResult = await acceptAndNotifyMatchedRules([{
    origin: "C",
    destination: "D",
    vehicle_type: "4W",
    booking_id: 2706816,
    request_id: 38659806,
  }], lostRaceApiClient as never, {
    teamId: team.id,
    notificationContext: { teamId: team.id, teamName: team.name, lineGroupId: "" },
    autoAcceptRules: [lostRaceRule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    verificationMode: "detached",
  });

  assert.equal(lostRaceResult.pendingVerification, 1);
  await awaitAutoAcceptVerificationIdle();

  const failedRows = await waitFor(
    () => getAutoAcceptHistory(team.id, { limit: 20 }),
    (rows) => rows.some((row) => row.bookingId === 2706816 && row.status === "failed"),
    "detached lost-race history row",
  );
  const failedRow = failedRows.find((row) => row.bookingId === 2706816);
  assert.equal(failedRow?.failureReason, "lost_race");
  assert.equal(failedRow?.verificationStatus, "verified_failed");

  const apiFailureRule = await rules.createRule(team.id, {
    name: "Detached API Failure",
    origins: ["E"],
    destinations: ["F"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });

  const apiFailureClient = {
    acceptBookingRequests: async () => ({ ok: false, httpStatus: 503, response: { retcode: 503, message: "upstream unavailable" }, error: "upstream unavailable" }),
    fetchBookingRequestList: async () => requestListResponse([]),
  };

  const apiFailureResult = await acceptAndNotifyMatchedRules([{
    origin: "E",
    destination: "F",
    vehicle_type: "4W",
    booking_id: 2706817,
    request_id: 38659807,
  }], apiFailureClient as never, {
    teamId: team.id,
    notificationContext: { teamId: team.id, teamName: team.name, lineGroupId: "" },
    autoAcceptRules: [apiFailureRule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    verificationMode: "detached",
  });

  assert.equal(apiFailureResult.pendingVerification, 1);
  assert.equal(apiFailureResult.deferredRequests, 1, "unclean detached accepts should keep the booking retry-eligible");
  await awaitAutoAcceptVerificationIdle();

  const apiFailureRows = await waitFor(
    () => getAutoAcceptHistory(team.id, { limit: 20 }),
    (rows) => rows.some((row) => row.bookingId === 2706817 && row.status === "failed"),
    "detached API-failure history row",
  );
  const apiFailureRow = apiFailureRows.find((row) => row.bookingId === 2706817);
  assert.equal(apiFailureRow?.failureReason, "accept_api_error");

  const inlineFailureRule = await rules.createRule(team.id, {
    name: "Inline Clear Failure",
    origins: ["G"],
    destinations: ["H"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });

  let inlineFailureFetches = 0;
  const inlineFailureClient = {
    acceptBookingRequests: async () => ({ ok: false, httpStatus: 409, response: { retcode: 409, message: "already accepted" }, error: "already accepted" }),
    fetchBookingRequestList: async () => {
      inlineFailureFetches += 1;
      return requestListResponse([]);
    },
  };

  const inlineFailureResult = await acceptAndNotifyMatchedRules([{
    origin: "G",
    destination: "H",
    vehicle_type: "4W",
    booking_id: 2706818,
    request_id: 38659808,
  }], inlineFailureClient as never, {
    teamId: team.id,
    notificationContext: { teamId: team.id, teamName: team.name, lineGroupId: "" },
    autoAcceptRules: [inlineFailureRule],
    needBudget: new NeedBudget(),
    deferSideEffects: false,
  });

  assert.equal(inlineFailureFetches, 0, "single clear failure should keep the existing skip-verify behavior");
  assert.equal(inlineFailureResult.failed.length, 1);
  assert.equal(await getAutoAcceptResult(team.id, 2706818, 38659808), null, "raw clear failures must not create canonical result facts");

  const originalRole = env.SPX_ROLE;
  (env as unknown as { SPX_ROLE: typeof env.SPX_ROLE }).SPX_ROLE = "worker";
  const published: PublishEnvelope[] = [];
  setWorkerNotificationPublisherForTests(createNotificationPublisher({
    publish: async (envelope) => {
      published.push(envelope);
      return { ok: true };
    },
  }));
  const inlineSuccessRule = await rules.createRule(team.id, {
    name: "Inline Worker Trace",
    origins: ["I"],
    destinations: ["J"],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  });
  const inlineSuccessClient = {
    acceptBookingRequests: async () => ({ ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } }),
    fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
      return options?.tabPendingConfirmation === false
        ? requestListResponse([{ request_id: 38659809, booking_id: 2706819, request_acceptance_status: 2 }])
        : requestListResponse([]);
    },
  };

  await acceptAndNotifyMatchedRules([{
    origin: "I",
    destination: "J",
    vehicle_type: "4W",
    booking_id: 2706819,
    request_id: 38659809,
  }], inlineSuccessClient as never, {
    teamId: team.id,
    notificationContext: { teamId: team.id, teamName: team.name, lineGroupId: "" },
    autoAcceptRules: [inlineSuccessRule],
    needBudget: new NeedBudget(),
    deferSideEffects: false,
  });
  assert.equal(published.length, 1);
  assert.match(published[0]?.event.traceId ?? "", new RegExp(`^aa:${team.id}:2706819:38659809:`));
  (env as unknown as { SPX_ROLE: typeof env.SPX_ROLE }).SPX_ROLE = originalRole;
  setWorkerNotificationPublisherForTests(null);

  await closePool();
  console.log("auto-accept-detached-verify: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
