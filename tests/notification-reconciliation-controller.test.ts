import assert from "node:assert/strict";
import Fastify from "fastify";
import { notificationReconciliationController } from "../src/controllers/notification-reconciliation-controller.js";

const baseBody = {
  action: "mark_sent",
  expectedStatus: "delivery_ambiguous",
  providerRequestId: "transport-request-123",
  expectedProviderStartedAt: "2030-06-29 09:00:03",
  confirmation: "PROVIDER_CONFIRMED_SENT",
  evidenceReference: "LINE-console-message-123",
  reason: "LINE console confirms the message was delivered",
  providerMessageId: "line-message-123",
};

async function main(): Promise<void> {
  const calls: unknown[] = [];
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    (request as typeof request & { user: unknown }).user = {
      id: 17,
      username: "operator-admin",
      role: "admin",
      teamId: null,
    };
  });
  await app.register(notificationReconciliationController, {
    prefix: "/api/notification-reconciliation",
    listCandidates: async () => [{
      outboxId: 42,
      teamId: 2,
      status: "delivery_ambiguous",
      providerRequestId: "transport-request-123",
      lockedBy: null,
      attempts: 1,
      providerStartedAt: "2030-06-29 09:00:03",
      updatedAt: "2030-06-29 09:00:04",
    }],
    reconcile: async (input) => {
      calls.push(input);
      return { state: "reconciled", status: "sent" };
    },
  });

  try {
    const candidates = await app.inject({
      method: "GET",
      url: "/api/notification-reconciliation",
    });
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.deepEqual(JSON.parse(candidates.body).data, [{
      outboxId: 42,
      teamId: 2,
      status: "delivery_ambiguous",
      providerRequestId: "transport-request-123",
      lockedBy: null,
      attempts: 1,
      providerStartedAt: "2030-06-29 09:00:03",
      updatedAt: "2030-06-29 09:00:04",
    }]);
    assert.doesNotMatch(candidates.body, /targetId|message|payload|C123/);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/notification-reconciliation/42",
      payload: baseBody,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(JSON.parse(accepted.body), {
      status: "success",
      data: { outboxId: 42, status: "sent" },
    });
    assert.deepEqual(calls, [{
      outboxId: 42,
      action: "mark_sent",
      expectedStatus: "delivery_ambiguous",
      providerRequestId: "transport-request-123",
      expectedProviderStartedAt: "2030-06-29 09:00:03",
      evidenceReference: "LINE-console-message-123",
      reason: "LINE console confirms the message was delivered",
      providerMessageId: "line-message-123",
      actor: { userId: 17, username: "operator-admin", teamId: null },
    }]);
    assert.doesNotMatch(accepted.body, /transport-request|evidenceReference|reason/);

    for (const payload of [
      { ...baseBody, confirmation: "yes" },
      { ...baseBody, action: "requeue_not_sent", confirmation: "PROVIDER_CONFIRMED_SENT" },
      { ...baseBody, evidenceReference: "short" },
      { ...baseBody, reason: "bad\nreason" },
      { ...baseBody, providerRequestId: "" },
      { ...baseBody, expectedProviderStartedAt: "" },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/notification-reconciliation/42",
        payload,
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(JSON.parse(invalid.body).error_code, "NOTIFICATION_RECONCILIATION_INVALID");
    }
    assert.equal(calls.length, 1);

    const invalidId = await app.inject({
      method: "POST",
      url: "/api/notification-reconciliation/not-a-number",
      payload: baseBody,
    });
    assert.equal(invalidId.statusCode, 400);
  } finally {
    await app.close();
  }

  for (const [state, expectedStatus, expectedCode] of [
    ["missing", 404, "NOTIFICATION_OUTBOX_NOT_FOUND"],
    ["conflict", 409, "NOTIFICATION_RECONCILIATION_CONFLICT"],
  ] as const) {
    const outcomeApp = Fastify({ logger: false });
    outcomeApp.addHook("preHandler", async (request) => {
      (request as typeof request & { user: unknown }).user = {
        id: 17,
        username: "operator-admin",
        role: "admin",
        teamId: null,
      };
    });
    await outcomeApp.register(notificationReconciliationController, {
      prefix: "/api/notification-reconciliation",
      reconcile: async () => ({ state }),
    });
    try {
      const response = await outcomeApp.inject({
        method: "POST",
        url: "/api/notification-reconciliation/42",
        payload: baseBody,
      });
      assert.equal(response.statusCode, expectedStatus);
      assert.equal(JSON.parse(response.body).error_code, expectedCode);
    } finally {
      await outcomeApp.close();
    }
  }

  console.log("notification-reconciliation-controller: guarded operator actions verified");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
