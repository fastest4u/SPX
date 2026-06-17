import assert from "node:assert/strict";

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-accept-all-test-key";

function requestListResponse(requests: Array<{ request_id: number; booking_id: number; request_acceptance_status: number }>) {
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

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const { LogLevel, setLogLevel } = await import("../src/utils/logger.js");
  const { acceptAndNotifyMatchedRules, NeedBudget } = await import("../src/services/notifier.js");
  const { createRule, readRules } = await import("../src/services/notify-rules.js");
  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);

  const normalRule = await createRule(1, {
    name: "Normal lane",
    origins: ["NORC-B"],
    destinations: ["SOCs"],
    vehicle_types: ["6WH-6ล้อ[7.2m]"],
    need: 1,
    enabled: true,
    accept_all: false,
  });

  const acceptAllRule = await createRule(1, {
    name: "Accept all lane",
    origins: ["NORC-B"],
    destinations: ["SOCs"],
    vehicle_types: ["6WH-6ล้อ[7.2m]"],
    need: 1,
    enabled: true,
    accept_all: true,
  });
  assert.equal(acceptAllRule.accept_all, true);

  const normalTrip = {
    origin: "NORC-B",
    destination: "SOCs",
    vehicle_type: "6WH-6ล้อ[7.2m]",
    booking_id: 2706815,
    request_id: 38659805,
  };
  const acceptAllTrip = {
    ...normalTrip,
    booking_id: 2706816,
    request_id: 38659806,
  };

  let normalAcceptCalls = 0;
  let acceptAllCalls = 0;
  const normalApiClient = {
    acceptBookingRequests: async (bookingId: number, requestIds: number[]) => {
      normalAcceptCalls += 1;
      assert.equal(bookingId, 2706815);
      assert.deepEqual(requestIds, [38659805]);
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } };
    },
    acceptAllBookingRequests: async () => {
      acceptAllCalls += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "unexpected" } };
    },
    fetchBookingRequestList: async () => requestListResponse([
      { request_id: 38659805, booking_id: 2706815, request_acceptance_status: 2 },
    ]),
  };

  const normalResult = await acceptAndNotifyMatchedRules([normalTrip], normalApiClient as never, {
    autoAcceptRules: [normalRule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    notificationContext: { teamId: 1, teamName: "PTWL", lineGroupId: "" },
  });

  assert.equal(normalAcceptCalls, 1);
  assert.equal(acceptAllCalls, 0);
  assert.equal(normalResult.accepted.length, 1);

  let requestListAcceptCalls = 0;
  let bookingAcceptAllCalls = 0;
  const acceptAllApiClient = {
    acceptBookingRequests: async () => {
      requestListAcceptCalls += 1;
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "unexpected" } };
    },
    acceptAllBookingRequests: async (bookingId: number) => {
      bookingAcceptAllCalls += 1;
      assert.equal(bookingId, 2706816);
      return { ok: true, httpStatus: 200, response: { retcode: 0, message: "success" } };
    },
    fetchBookingRequestList: async () => requestListResponse([
      { request_id: 38659806, booking_id: 2706816, request_acceptance_status: 2 },
    ]),
  };

  const acceptAllResult = await acceptAndNotifyMatchedRules([acceptAllTrip], acceptAllApiClient as never, {
    autoAcceptRules: [acceptAllRule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    notificationContext: { teamId: 1, teamName: "PTWL", lineGroupId: "" },
  });

  assert.equal(requestListAcceptCalls, 0);
  assert.equal(bookingAcceptAllCalls, 1);
  assert.equal(acceptAllResult.accepted.length, 1);

  assert.equal((await readRules(1)).find((rule) => rule.id === acceptAllRule.id)?.accept_all, true);

  await closePool();
  console.log("auto-accept-accept-all: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
