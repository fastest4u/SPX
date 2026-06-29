process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "internal-notification-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import { internalNotificationController } from "../src/controllers/internal-notification-controller.js";
import { sendError } from "../src/utils/response.js";
import { createTeam } from "../src/repositories/team-repository.js";
import { getDb } from "../src/db/client.js";
import { notificationOutbox } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

type ApiBody<T = unknown> = {
  status: "success" | "error";
  data?: T;
  error_code?: string;
  message?: string;
};

type NotificationResult = {
  duplicate: boolean;
  eventId: number | null;
  outboxId: number;
  outboxStatus: string;
};

const sharedSecret = "test-notifier-secret";
const nodeId = "ptwl-worker-01";
const timestamp = new Date().toISOString();
const internalPath = "/internal/notification-events";

function parseBody<T>(response: { body: string }): ApiBody<T> {
  return JSON.parse(response.body) as ApiBody<T>;
}

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventType: "auto_accept_result",
    severity: "success",
    teamId: 2,
    teamName: "PTWL",
    bookingId: "2791810",
    requestIds: ["40288114"],
    status: "owned",
    message: "accepted booking 2791810",
    occurredAt: timestamp,
    ...overrides,
  };
}

function signedHeaders(body: string, eventKey: string, headerNodeId = nodeId) {
  return {
    "content-type": "application/json",
    "idempotency-key": eventKey,
    "x-spx-node-id": headerNodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body,
      timestamp,
      nodeId: headerNodeId,
      path: internalPath,
      secret: sharedSecret,
      eventKey,
    }),
  };
}

async function createApp(options: { allowedNodes?: Map<string, Set<number>> } = {}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    return sendError(reply, statusCode, "REQUEST_ERROR", error instanceof Error ? error.message : String(error));
  });
  await app.register(internalNotificationController, {
    prefix: "/internal",
    sharedSecret,
    ...options,
  });
  await app.ready();
  return app;
}

async function resetDb() {
  await closePool();
  resetMemoryDb();
}

async function main(): Promise<void> {
  await resetDb();
  await createTeam({
    name: "IFN",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "C-ifn-line-group",
  });
  await createTeam({
    name: "PTWL",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "C-ptwl-line-group",
  });
  const app = await createApp({ allowedNodes: new Map([[nodeId, new Set([2])]]) });

  try {
    const eventKey = "auto_accept_owned:team:2:booking:2791810:req:40288114";
    const body = JSON.stringify(buildPayload());
    const first = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, eventKey),
      payload: body,
    });
    assert.equal(first.statusCode, 200);
    const firstBody = parseBody<NotificationResult>(first);
    assert.equal(firstBody.status, "success");
    assert.equal(firstBody.data?.duplicate, false);
    assert.equal(firstBody.data?.outboxStatus, "queued");
    const db = await getDb();
    const [outboxRow] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, firstBody.data!.outboxId))
      .limit(1);
    assert.equal(outboxRow?.targetId, "C-ptwl-line-group");

    const duplicate = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, eventKey),
      payload: body,
    });
    assert.equal(duplicate.statusCode, 200);
    const duplicateBody = parseBody<NotificationResult>(duplicate);
    assert.equal(duplicateBody.data?.duplicate, true);
    assert.equal(duplicateBody.data?.outboxId, firstBody.data?.outboxId);

    const replayWithMutatedEventKey = await app.inject({
      method: "POST",
      url: internalPath,
      headers: {
        ...signedHeaders(body, eventKey),
        "idempotency-key": `${eventKey}:mutated`,
      },
      payload: body,
    });
    assert.equal(replayWithMutatedEventKey.statusCode, 401);
    assert.equal(parseBody(replayWithMutatedEventKey).error_code, "INTERNAL_AUTH_FAILED");

    const forbiddenBody = JSON.stringify(buildPayload({ teamId: 3, teamName: "Forbidden Team" }));
    const forbidden = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(forbiddenBody, "auto_accept_owned:team:3:booking:2791810:req:40288114"),
      payload: forbiddenBody,
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(parseBody(forbidden).error_code, "INTERNAL_NODE_TEAM_FORBIDDEN");

    const badSignature = await app.inject({
      method: "POST",
      url: internalPath,
      headers: {
        ...signedHeaders(body, "bad-signature-event"),
        "x-spx-signature": "0".repeat(64),
      },
      payload: body,
    });
    assert.equal(badSignature.statusCode, 401);
    assert.equal(parseBody(badSignature).error_code, "INTERNAL_AUTH_FAILED");

    const invalidBody = JSON.stringify(buildPayload({ requestIds: [] }));
    const invalid = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(invalidBody, "invalid-payload-event"),
      payload: invalidBody,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(parseBody(invalid).error_code, "INTERNAL_NOTIFICATION_INVALID");
  } finally {
    await app.close();
    await resetDb();
  }

  await createTeam({
    name: "IFN",
    enabled: true,
    spxCookie: "cookie",
    spxDeviceId: "device",
    lineGroupId: "C-ifn-line-group",
  });
  const unrestrictedApp = await createApp();
  try {
    const unrestrictedNodeId = "ifn-worker-01";
    const eventKey = "auto_accept_owned:team:1:booking:2791811:req:40288115";
    const body = JSON.stringify(buildPayload({
      teamId: 1,
      teamName: "IFN",
      bookingId: "2791811",
      requestIds: ["40288115"],
    }));
    const response = await unrestrictedApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, eventKey, unrestrictedNodeId),
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(parseBody<NotificationResult>(response).data?.outboxStatus, "queued");
  } finally {
    await unrestrictedApp.close();
    await resetDb();
  }

  console.log("internal-notification-controller: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
