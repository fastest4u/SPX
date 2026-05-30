import assert from "node:assert/strict";
import {
  buildBiddingListBody,
  normalizeApiResponse,
} from "../src/services/api-client.js";
import { env } from "../src/config/env.js";

const mutableEnv = env as unknown as {
  BIDDING_PAGE_NO: number;
  BIDDING_PAGE_COUNT: number;
  REQUEST_TAB_PENDING_CONFIRMATION: boolean;
  REQUEST_CTIME_START: number;
  BIDDING_VEHICLE_TYPE?: number;
};

const original = {
  BIDDING_PAGE_NO: mutableEnv.BIDDING_PAGE_NO,
  BIDDING_PAGE_COUNT: mutableEnv.BIDDING_PAGE_COUNT,
  REQUEST_TAB_PENDING_CONFIRMATION: mutableEnv.REQUEST_TAB_PENDING_CONFIRMATION,
  REQUEST_CTIME_START: mutableEnv.REQUEST_CTIME_START,
  BIDDING_VEHICLE_TYPE: mutableEnv.BIDDING_VEHICLE_TYPE,
};

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
} finally {
  Object.assign(mutableEnv, original);
}
