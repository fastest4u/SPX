process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "internal-realtime-controller-test-key";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { internalRealtimeController } from "../src/controllers/internal-realtime-controller.js";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { getRealtimeEventByEventId } from "../src/repositories/realtime-event-repository.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import type {
  RealtimePublisher,
  RealtimePublishInput,
  RealtimePublishResult,
} from "../src/services/realtime-contract.js";

type ApiBody<T = unknown> = {
  status: "success" | "error";
  data?: T;
  error_code?: string;
  message?: string;
  details?: unknown;
};

class CapturingRealtimePublisher implements RealtimePublisher {
  readonly inputs: RealtimePublishInput[] = [];

  async publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    this.inputs.push(input as RealtimePublishInput);
    return {
      accepted: true,
      duplicate: false,
      id: `${input.type}:published`,
      receivedAt: "2030-01-01T00:00:00.000Z",
      persisted: false,
    };
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish(input);
  }
}

class ThrowingRealtimePublisher implements RealtimePublisher {
  async publish<TPayload>(_input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    throw new Error("realtime transport unavailable");
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish(input);
  }
}

const sharedSecret = "r".repeat(32);
const workerNodeId = "worker-ifn-01";
const adminNodeId = "notification-service-01";
const internalPath = "/internal/realtime/events";
let requestSequence = 0;

function parseBody<T>(response: { body: string }): ApiBody<T> {
  return JSON.parse(response.body) as ApiBody<T>;
}

function signedHeaders(
  body: string,
  nodeId: string,
  eventKey?: string,
  secret = sharedSecret,
  requestId = `realtime-request-${++requestSequence}`,
): Record<string, string> {
  const timestamp = new Date().toISOString();
  return {
    "content-type": "application/json",
    ...(eventKey ? { "idempotency-key": eventKey } : {}),
    "x-spx-node-id": nodeId,
    "x-spx-request-id": requestId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body,
      timestamp,
      nodeId,
      path: internalPath,
      secret,
      eventKey,
      requestId,
    }),
  };
}

function teamEvent(overrides: Partial<RealtimePublishInput> = {}): RealtimePublishInput<{ queued: number }> {
  return {
    type: "notification.queue.changed",
    payloadVersion: 1,
    payload: { queued: 3 },
    source: { service: "worker", nodeId: workerNodeId, role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    replayable: true,
    idempotencyKey: "notification:queue:team:2",
    ...overrides,
  };
}

function adminEvent(overrides: Partial<RealtimePublishInput> = {}): RealtimePublishInput<{ active: number }> {
  return {
    type: "runtime.node.changed",
    payloadVersion: 1,
    payload: { active: 4 },
    source: { service: "notification-service", nodeId: adminNodeId, role: "notification-service" },
    scope: { kind: "admin" },
    ...overrides,
  };
}

async function createApp(options: {
  publisher?: RealtimePublisher;
  allowedNodes?: Map<string, Set<number>>;
  adminPublishers?: Set<string>;
} = {}) {
  const app = Fastify({ logger: false });
  await app.register(internalRealtimeController, {
    prefix: "/internal/realtime",
    sharedSecret,
    ...options,
  });
  await app.ready();
  return app;
}

async function main(): Promise<void> {
  const publisher = new CapturingRealtimePublisher();
  const app = await createApp({
    publisher,
    allowedNodes: new Map([[workerNodeId, new Set([2])]]),
    adminPublishers: new Set([adminNodeId]),
  });

  try {
    const missingAuth = await app.inject({
      method: "POST",
      url: internalPath,
      payload: {},
    });
    assert.equal(missingAuth.statusCode, 401);
    assert.equal(parseBody(missingAuth).error_code, "INTERNAL_AUTH_FAILED");

    const invalidBody = "not-json";
    const invalid = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(invalidBody, workerNodeId),
      payload: invalidBody,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(parseBody(invalid).error_code, "INTERNAL_REALTIME_INVALID");

    const replayable = teamEvent();
    const replayableBody = JSON.stringify(replayable);
    const missingEventKey = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(replayableBody, workerNodeId),
      payload: replayableBody,
    });
    assert.equal(missingEventKey.statusCode, 400);
    assert.equal(parseBody(missingEventKey).error_code, "INTERNAL_REALTIME_IDEMPOTENCY_REQUIRED");

    const mismatchedEventKey = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(replayableBody, workerNodeId, "notification:queue:team:999"),
      payload: replayableBody,
    });
    assert.equal(mismatchedEventKey.statusCode, 400);
    assert.equal(parseBody(mismatchedEventKey).error_code, "INTERNAL_REALTIME_IDEMPOTENCY_REQUIRED");

    const accepted = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(replayableBody, workerNodeId, replayable.idempotencyKey),
      payload: replayableBody,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(parseBody<RealtimePublishResult>(accepted).data?.id, "notification.queue.changed:published");
    assert.equal(publisher.inputs.length, 1);
    assert.deepEqual(publisher.inputs[0], replayable);

    const replayEvent = teamEvent({ idempotencyKey: "notification:queue:team:2:transport-replay" });
    const replayBody = JSON.stringify(replayEvent);
    const replayHeaders = signedHeaders(
      replayBody,
      workerNodeId,
      replayEvent.idempotencyKey,
      sharedSecret,
      "realtime-replayed-request",
    );
    const replayFirst = await app.inject({
      method: "POST",
      url: internalPath,
      headers: replayHeaders,
      payload: replayBody,
    });
    assert.equal(replayFirst.statusCode, 200);
    const replaySecond = await app.inject({
      method: "POST",
      url: internalPath,
      headers: replayHeaders,
      payload: replayBody,
    });
    assert.equal(replaySecond.statusCode, 409);
    assert.equal(parseBody(replaySecond).error_code, "INTERNAL_REQUEST_REPLAYED");

    const forbiddenTeam = teamEvent({
      scope: { kind: "team", teamId: 3 },
      subject: { type: "team", id: "3", teamId: 3 },
    });
    const forbiddenTeamBody = JSON.stringify(forbiddenTeam);
    const forbidden = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(forbiddenTeamBody, workerNodeId, forbiddenTeam.idempotencyKey),
      payload: forbiddenTeamBody,
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(parseBody(forbidden).error_code, "INTERNAL_REALTIME_SCOPE_FORBIDDEN");
    assert.equal(publisher.inputs.length, 2);

    const adminBody = JSON.stringify(adminEvent());
    const adminForbidden = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(adminBody, workerNodeId),
      payload: adminBody,
    });
    assert.equal(adminForbidden.statusCode, 403);
    assert.equal(parseBody(adminForbidden).error_code, "INTERNAL_REALTIME_SCOPE_FORBIDDEN");

    const adminAccepted = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(adminBody, adminNodeId),
      payload: adminBody,
    });
    assert.equal(adminAccepted.statusCode, 200);
    assert.equal(parseBody<RealtimePublishResult>(adminAccepted).data?.id, "runtime.node.changed:published");
    assert.equal(publisher.inputs.length, 3);

    const invalidEvent = { ...teamEvent(), type: "legacy.metrics" };
    const invalidEventBody = JSON.stringify(invalidEvent);
    const invalidEventResponse = await app.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(invalidEventBody, workerNodeId, invalidEvent.idempotencyKey),
      payload: invalidEventBody,
    });
    assert.equal(invalidEventResponse.statusCode, 400);
    assert.equal(parseBody(invalidEventResponse).error_code, "INTERNAL_REALTIME_INVALID");
  } finally {
    await app.close();
  }

  await closePool();
  resetMemoryDb();
  const defaultPublisherApp = await createApp({
    allowedNodes: new Map([[workerNodeId, new Set([2])]]),
  });
  try {
    const replayable = teamEvent();
    const body = JSON.stringify(replayable);
    const response = await defaultPublisherApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, workerNodeId, replayable.idempotencyKey),
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    const result = parseBody<RealtimePublishResult>(response).data;
    assert.ok(result);
    assert.equal(result.persisted, true);
    assert.equal(result.duplicate, false);

    const stored = await getRealtimeEventByEventId(result.id);
    assert.ok(stored);
    assert.equal(stored.eventType, "notification.queue.changed");
    assert.equal(stored.idempotencyKey, replayable.idempotencyKey);

    const duplicate = await defaultPublisherApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, workerNodeId, replayable.idempotencyKey),
      payload: body,
    });
    assert.equal(duplicate.statusCode, 200);
    const duplicateResult = parseBody<RealtimePublishResult>(duplicate).data;
    assert.ok(duplicateResult);
    assert.equal(duplicateResult.persisted, true);
    assert.equal(duplicateResult.duplicate, true);
    assert.equal(duplicateResult.id, result.id);
  } finally {
    await defaultPublisherApp.close();
  }

  const degradedApp = await createApp({
    publisher: new ThrowingRealtimePublisher(),
    allowedNodes: new Map([[workerNodeId, new Set([2])]]),
  });
  try {
    const replayable = teamEvent();
    const body = JSON.stringify(replayable);
    const response = await degradedApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(body, workerNodeId, replayable.idempotencyKey),
      payload: body,
    });
    assert.equal(response.statusCode, 503);
    const bodyParsed = parseBody(response);
    assert.equal(bodyParsed.error_code, "INTERNAL_REALTIME_PUBLISH_FAILED");
    assert.deepEqual(bodyParsed.details, { retryable: true });
  } finally {
    await degradedApp.close();
  }

  const workerSecret = "w".repeat(32);
  const adminSecret = "a".repeat(32);
  const resolverPublisher = new CapturingRealtimePublisher();
  const resolverApp = Fastify({ logger: false });
  await resolverApp.register(internalRealtimeController, {
    prefix: "/internal/realtime",
    sharedSecret,
    resolveSecretForNode: (nodeId) => new Map([
      [workerNodeId, { active: workerSecret }],
      [adminNodeId, { active: adminSecret }],
    ]).get(nodeId),
    publisher: resolverPublisher,
    allowedNodes: new Map([[workerNodeId, new Set([2])]]),
    adminPublishers: new Set([adminNodeId]),
  });
  await resolverApp.ready();
  try {
    const workerEvent = teamEvent({ idempotencyKey: "notification:queue:team:2:per-node" });
    const workerBody = JSON.stringify(workerEvent);
    const accepted = await resolverApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(workerBody, workerNodeId, workerEvent.idempotencyKey, workerSecret),
      payload: workerBody,
    });
    assert.equal(accepted.statusCode, 200, "the claimed node's own secret must authenticate");

    const adminBody = JSON.stringify(adminEvent());
    const impersonatedAdmin = await resolverApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(adminBody, adminNodeId, undefined, workerSecret),
      payload: adminBody,
    });
    assert.equal(
      impersonatedAdmin.statusCode,
      401,
      "a team-scoped node secret must not authenticate a claimed admin node id",
    );

    const sharedSecretImpersonation = await resolverApp.inject({
      method: "POST",
      url: internalPath,
      headers: signedHeaders(adminBody, adminNodeId),
      payload: adminBody,
    });
    assert.equal(
      sharedSecretImpersonation.statusCode,
      401,
      "the legacy shared secret must not authenticate a node that has a per-node mapping",
    );
    assert.equal(resolverPublisher.inputs.length, 1);
  } finally {
    await resolverApp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
