import assert from "node:assert/strict";
import type { ApiClient } from "../src/services/api-client.js";
import { acceptAndNotifyMatchedRules, NeedBudget } from "../src/services/notifier.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

const rule: NotifyRule = {
  id: "rule-ambiguous-timeout",
  name: "Ambiguous timeout",
  origins: ["Bangkok"],
  destinations: ["Rayong"],
  vehicle_types: ["13"],
  need: 1,
  enabled: true,
  fulfilled: false,
  auto_accept: true,
  accept_all: false,
  auto_accepted: false,
};

const trip = {
  origin: "Bangkok",
  destination: "Rayong",
  vehicle_type: "13",
  booking_id: 9001,
  request_id: 7001,
};

const apiClient = {
  acceptBookingRequests: async () => ({
    ok: false,
    httpStatus: 0,
    response: null,
    error: "timeout after 10000ms",
  }),
  fetchBookingRequestList: async () => ({
    retcode: 0,
    message: "",
    data: {
      pageno: 1,
      count: 1,
      total: 1,
      request_list: [
        {
          request_id: 7001,
          booking_id: 9001,
          request_acceptance_status: 1,
        },
      ],
    },
  }),
} as unknown as ApiClient;

async function main(): Promise<void> {
  const result = await acceptAndNotifyMatchedRules([trip], apiClient, {
    autoAcceptRules: [rule],
    needBudget: new NeedBudget(),
    deferSideEffects: true,
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.deferredRequests, 1);
  assert.equal(result.notified, false);

  console.log("auto-accept-ambiguous-timeout: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
