import assert from "node:assert/strict";

process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "auto-accept-success-verify-test-key";

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

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const { LogLevel, setLogLevel } = await import("../src/utils/logger.js");
  const { acceptAndNotifyMatchedRules, NeedBudget } = await import("../src/services/notifier.js");
  const { closePool } = await import("../src/db/client.js");
  resetMemoryDb();
  setLogLevel(LogLevel.ERROR);

  const rule = {
    id: "rule-success-must-verify",
    name: "เชียงใหม่",
    origins: ["NORC-B"],
    destinations: ["SOCE"],
    vehicle_types: ["6WH-6ล้อ[7.2m]"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  } as const;

  const trip = {
    origin: "NORC-B",
    destination: "SOCE",
    vehicle_type: "6WH-6ล้อ[7.2m]",
    booking_id: 2706815,
    request_id: 38659805,
  };

  let verifyCalls = 0;
  const apiClient = {
    acceptBookingRequests: async () => ({
      ok: true,
      httpStatus: 200,
      response: { retcode: 0, message: "success" },
    }),
    fetchBookingRequestList: async (_bookingId: number, options?: { tabPendingConfirmation?: boolean }) => {
      verifyCalls += 1;
      const pending = options?.tabPendingConfirmation !== false;
      return pending
        ? requestListResponse([])
        : requestListResponse([
            {
              request_id: 38659805,
              booking_id: 2706815,
              request_acceptance_status: 4,
              remark: "Other agency accept first.",
            },
          ]);
    },
  };

  const result = await acceptAndNotifyMatchedRules([trip], apiClient as never, {
    autoAcceptRules: [rule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
    notificationContext: { teamId: 1, teamName: "PTWL", lineGroupId: "" },
  });

  assert.equal(verifyCalls, 2, "successful accept responses must still verify both request-list tabs");
  assert.equal(result.accepted.length, 0);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.failed[0]?.requestIds, [38659805]);
  assert.equal(result.deferredRequests, 0);
  assert.equal(result.notified, false);

  await closePool();
  console.log("auto-accept-success-verify: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
