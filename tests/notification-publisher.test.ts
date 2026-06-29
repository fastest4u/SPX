import assert from "node:assert/strict";
import {
  buildAutoAcceptOwnedEvent,
  createNotificationPublisher,
  type PublishEnvelope,
} from "../src/services/notification-publisher.js";
import { env } from "../src/config/env.js";
import {
  acceptAndNotifyMatchedRules,
  NeedBudget,
  routeAutoAcceptSuccessNotification,
  sendSessionExpiryNotification,
  setWorkerNotificationPublisherForTests,
} from "../src/services/notifier.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

const ownedInput = {
  teamId: 2,
  teamName: "PTWL",
  bookingId: 2791810,
  requestIds: [40288114],
  traceId: "aa:2:2791810:40288114:123",
  message: "PTWL accepted request 40288114.",
  evidence: { acceptRttMs: 82, source: "notifier" },
};

const ownedEnvelope = buildAutoAcceptOwnedEvent(ownedInput);
assert.equal(ownedEnvelope.eventKey, "auto_accept_owned:team:2:booking:2791810:req:40288114");
assert.equal(ownedEnvelope.event.eventType, "auto_accept_result");
assert.equal(ownedEnvelope.event.severity, "success");
assert.equal(ownedEnvelope.event.status, "owned");
assert.equal(ownedEnvelope.event.reasonCode, "verified_owned");
assert.equal(ownedEnvelope.event.teamId, 2);
assert.equal(ownedEnvelope.event.teamName, "PTWL");
assert.equal(ownedEnvelope.event.bookingId, "2791810");
assert.deepEqual(ownedEnvelope.event.requestIds, ["40288114"]);
assert.equal(ownedEnvelope.event.traceId, "aa:2:2791810:40288114:123");
assert.equal(ownedEnvelope.event.message, "PTWL accepted request 40288114.");
assert.deepEqual(ownedEnvelope.event.evidence, { acceptRttMs: 82, source: "notifier" });
assert.equal(typeof ownedEnvelope.event.occurredAt, "string");
assert.ok(Number.isFinite(Date.parse(ownedEnvelope.event.occurredAt)));

async function main(): Promise<void> {
  const published: PublishEnvelope[] = [];
  const publisher = createNotificationPublisher({
    publish: async (envelope) => {
      published.push(envelope);
      return { ok: true };
    },
  });

  const publishResult = await publisher.autoAcceptOwned(ownedInput);
  assert.deepEqual(publishResult, { ok: true });
  assert.equal(published.length, 1);
  assert.equal(published[0]?.eventKey, ownedEnvelope.eventKey);
  assert.deepEqual(
    { ...published[0]?.event, occurredAt: ownedEnvelope.event.occurredAt },
    ownedEnvelope.event,
  );
  assert.ok(Number.isFinite(Date.parse(published[0]?.event.occurredAt ?? "")));

  const originalRole = env.SPX_ROLE;
  const mutableEnv = env as { SPX_ROLE: typeof env.SPX_ROLE };
  const routed: PublishEnvelope[] = [];
  mutableEnv.SPX_ROLE = "worker";
  setWorkerNotificationPublisherForTests(createNotificationPublisher({
    publish: async (envelope) => {
      routed.push(envelope);
      return { ok: true };
    },
  }));
  try {
    const notified = await routeAutoAcceptSuccessNotification(
      [{ trip: {}, bookingId: 2791810, requestId: 40288114 }],
      {
        teamId: 2,
        notificationContext: { teamId: 2, teamName: "PTWL", lineGroupId: "line-group" },
        source: "notifier",
        traceId: "aa:2:2791810:40288114:123",
        evidence: { acceptedCount: 1 },
      },
    );

    assert.equal(notified, true);
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.eventKey, "auto_accept_owned:team:2:booking:2791810:req:40288114");
    assert.equal(routed[0]?.event.teamName, "PTWL");
    assert.equal(routed[0]?.event.message, "Auto-Accept accepted 40288114 for booking 2791810.");
    assert.deepEqual(routed[0]?.event.evidence, {
      requestCount: 1,
      source: "notifier",
      acceptedCount: 1,
    });

    const sessionResult = await sendSessionExpiryNotification(
      "session expired",
      { teamId: 2, teamName: "PTWL", lineGroupId: "" },
    );
    assert.equal(sessionResult.sent, true);
    assert.equal(sessionResult.results[0]?.channel, "central_notifier");
    assert.equal(routed.length, 2);
    assert.match(routed[1]?.eventKey ?? "", /^session_expired:team:2:/);
    assert.equal(routed[1]?.event.eventType, "session_expired");
    assert.equal(routed[1]?.event.teamName, "PTWL");

    const failureRule: NotifyRule = {
      id: "failure-rule",
      teamId: 2,
      teamName: "PTWL",
      name: "Failure Rule",
      origins: ["A"],
      destinations: ["B"],
      vehicle_types: ["4W"],
      need: 1,
      enabled: true,
      fulfilled: false,
      auto_accept: true,
      accept_all: false,
      auto_accepted: false,
    };
    const failureResult = await acceptAndNotifyMatchedRules(
      [{
        origin: "A",
        destination: "B",
        vehicle_type: "4W",
        booking_id: 2791812,
        request_id: 40288116,
      }],
      {
        acceptBookingRequests: async () => ({
          ok: false,
          httpStatus: 409,
          response: { retcode: 409, message: "already accepted" },
          error: "already accepted",
        }),
      } as never,
      {
        teamId: 2,
        notificationContext: { teamId: 2, teamName: "PTWL", lineGroupId: "" },
        autoAcceptRules: [failureRule],
        needBudget: new NeedBudget(),
      },
    );
    assert.equal(failureResult.failed.length, 1);
    assert.equal(routed.length, 3);
    assert.equal(routed[2]?.event.eventType, "auto_accept_failure");
    assert.equal(routed[2]?.event.status, "failed");
    assert.deepEqual(routed[2]?.event.requestIds, ["40288116"]);
  } finally {
    mutableEnv.SPX_ROLE = originalRole;
    setWorkerNotificationPublisherForTests(null);
  }
}

const multiRequestEnvelope = buildAutoAcceptOwnedEvent({
  ...ownedInput,
  requestIds: [40288114, 40288115, "40288116"],
});
assert.equal(multiRequestEnvelope.eventKey, "auto_accept_owned:team:2:booking:2791810:req:40288114");
assert.deepEqual(multiRequestEnvelope.event.requestIds, ["40288114", "40288115", "40288116"]);

assert.throws(
  () => buildAutoAcceptOwnedEvent({ ...ownedInput, requestIds: [] }),
  /requestIds must contain at least one id/,
);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
