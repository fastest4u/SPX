import assert from "node:assert/strict";
import {
  buildAutoAcceptEventKey,
  normalizeNotificationEvent,
  type NotificationEventInput,
} from "../src/services/notification-events.js";

assert.equal(
  buildAutoAcceptEventKey({ status: "owned", teamId: 2, bookingId: "2791810", requestId: "40288114" }),
  "auto_accept_owned:team:2:booking:2791810:req:40288114",
);

const event: NotificationEventInput = {
  schemaVersion: 1,
  eventType: "auto_accept_result",
  severity: "success",
  teamId: 2,
  teamName: "PTWL",
  bookingId: "2791810",
  requestIds: ["40288114"],
  status: "owned",
  reasonCode: "verified_owned",
  traceId: "aa:2:2791810:40288114:123",
  message: "PTWL accepted request 40288114.",
  occurredAt: "2026-06-29T04:24:04.000+07:00",
  evidence: { acceptRttMs: 82 },
};

const normalized = normalizeNotificationEvent(event, "ptwl-worker-01", "auto_accept_owned:team:2:booking:2791810:req:40288114");
assert.equal(normalized.workerNodeId, "ptwl-worker-01");
assert.equal(normalized.subjectType, "booking");
assert.equal(normalized.subjectId, "2791810");
assert.equal(normalized.payload.status, "owned");

const trimmed = normalizeNotificationEvent(
  { ...event, bookingId: " 2791810 " },
  " ptwl-worker-01 ",
  " auto_accept_owned:team:2:booking:2791810:req:40288114 ",
);
assert.equal(trimmed.workerNodeId, "ptwl-worker-01");
assert.equal(trimmed.eventKey, "auto_accept_owned:team:2:booking:2791810:req:40288114");
assert.equal(trimmed.subjectId, "2791810");
assert.equal(trimmed.payload.bookingId, "2791810");

assert.throws(() => normalizeNotificationEvent({ ...event, schemaVersion: 2 }, "node", "key"), /schemaVersion/);
assert.throws(() => normalizeNotificationEvent({ ...event, teamId: 0 }, "node", "key"), /teamId/);
assert.throws(() => normalizeNotificationEvent({ ...event, requestIds: [] }, "node", "key"), /requestIds/);
assert.throws(
  () => normalizeNotificationEvent({ ...event, eventType: "bad_event" } as unknown as NotificationEventInput, "node", "key"),
  /eventType must be one of/,
);
assert.throws(
  () => normalizeNotificationEvent({ ...event, eventType: 123 } as unknown as NotificationEventInput, "node", "key"),
  /eventType must be one of/,
);
assert.throws(
  () => normalizeNotificationEvent({ ...event, severity: "critical" } as unknown as NotificationEventInput, "node", "key"),
  /severity must be one of/,
);
assert.throws(
  () => normalizeNotificationEvent({ ...event, status: "stale" } as unknown as NotificationEventInput, "node", "key"),
  /status must be one of/,
);
assert.throws(() => normalizeNotificationEvent({ ...event, occurredAt: "not-a-date" }, "node", "key"), /occurredAt/);
assert.throws(() => normalizeNotificationEvent({ ...event, requestIds: [" "] }, "node", "key"), /requestIds/);
assert.throws(
  () => normalizeNotificationEvent({ ...event, requestIds: ["40288114", 123] } as unknown as NotificationEventInput, "node", "key"),
  /requestIds/,
);
