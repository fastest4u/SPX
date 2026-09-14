import assert from "node:assert/strict";

import {
  buildOperationWatermarkSql,
  compareOperationWatermarks,
  normalizeOperationWatermarkRow,
} from "../scripts/service-worker-operation-watermark-check.mjs";

const before = normalizeOperationWatermarkRow({
  bookingHistory: "10",
  autoAcceptAttempts: 20,
  autoAcceptResults: 30,
  autoAcceptHistory: 40,
  notificationEvents: 50,
  notificationOutbox: 60,
  metrics: 70,
  duplicateAnomalies: 0,
});
const after = { ...before, bookingHistory: 11, metrics: 71 };
assert.deepEqual(compareOperationWatermarks(before, after), { ok: true, failures: [] });
assert.deepEqual(
  compareOperationWatermarks(after, before).failures,
  ["WATERMARK_REGRESSED"],
);
assert.deepEqual(
  compareOperationWatermarks(before, { ...after, duplicateAnomalies: 1 }).failures,
  ["DUPLICATE_OPERATION_ANOMALY"],
);

const sql = buildOperationWatermarkSql();
for (const table of [
  "spx_booking_history",
  "auto_accept_attempts",
  "auto_accept_results",
  "auto_accept_history",
  "notification_events",
  "notification_outbox",
  "metrics_snapshots",
]) assert.match(sql, new RegExp(table));
assert.doesNotMatch(sql, /payload|message|target|error|booking_id|request_id/i);
assert.equal((sql.match(/team_id\s*=\s*\?/g) ?? []).length, 7);

console.log("worker operation watermark tests passed");
