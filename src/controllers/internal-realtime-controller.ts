import { validateExecutionMetricsEnvelope } from "../repositories/realtime-execution-metrics-repository.js";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  InternalRequestReplayGuard,
  type InternalRequestReplayStore,
  type NodeSecretKeyRing,
  verifyInternalNodeSignature,
  verifyInternalSignature,
} from "../services/internal-auth.js";
import {
  createRealtimeEnvelope,
  type RealtimePublisher,
  type RealtimePublishInput,
} from "../services/realtime-contract.js";
import { createPersistentInProcessRealtimePublisher } from "../services/realtime-publisher.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalRealtimeControllerOptions {
  sharedSecret?: string;
  resolveSecretForNode?: (nodeId: string) => NodeSecretKeyRing | string | undefined;
  publisher?: RealtimePublisher;
  allowedNodes?: Map<string, Set<number>>;
  adminPublishers?: Set<string>;
  replayGuard?: InternalRequestReplayStore;
}

const realtimeEventsPath = "/internal/realtime/events";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendInternalAuthFailed(reply: FastifyReply): void {
  sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", { retryable: false });
}

function sendInvalidRealtime(reply: FastifyReply, error: unknown): void {
  sendError(
    reply,
    400,
    "INTERNAL_REALTIME_INVALID",
    error instanceof Error ? error.message : "Invalid realtime event",
    { retryable: false },
  );
}

function verifyNodeSignature(
  input: {
    body: string;
    timestamp: string;
    nodeId: string;
    signature: string;
    eventKey?: string;
    requestId: string;
  },
  options: InternalRealtimeControllerOptions,
  onPreviousKeyUsed: () => void,
): boolean {
  let nodeSecret: NodeSecretKeyRing | string | undefined;
  try {
    nodeSecret = options.resolveSecretForNode?.(input.nodeId);
  } catch {
    return false;
  }

  if (options.resolveSecretForNode) {
    if (nodeSecret === undefined) return false;
    const ring = typeof nodeSecret === "string" ? { active: nodeSecret } : nodeSecret;
    return verifyInternalNodeSignature({
      body: input.body,
      timestamp: input.timestamp,
      nodeId: input.nodeId,
      path: realtimeEventsPath,
      nodeSecrets: new Map([[input.nodeId, ring]]),
      signature: input.signature,
      eventKey: input.eventKey,
      requestId: input.requestId,
      onKeyGeneration: (generation) => {
        if (generation === "previous") onPreviousKeyUsed();
      },
    }).ok;
  }

  const secret = options.sharedSecret;
  if (typeof secret !== "string" || secret.trim().length === 0) return false;
  return verifyInternalSignature({
    body: input.body,
    timestamp: input.timestamp,
    nodeId: input.nodeId,
    path: realtimeEventsPath,
    secret,
    signature: input.signature,
    eventKey: input.eventKey,
    requestId: input.requestId,
  }).ok;
}

async function consumeRequest(
  replayGuard: InternalRequestReplayStore,
  input: { nodeId: string; requestId: string; timestamp: string },
  reply: FastifyReply,
): Promise<boolean> {
  const result = await replayGuard.consume({
    nodeId: input.nodeId,
    requestId: input.requestId,
    signedTimestamp: input.timestamp,
    partition: "realtime-events",
  });
  if (result.ok) return true;
  if (result.reason === "capacity") {
    sendError(reply, 429, "INTERNAL_REPLAY_CAPACITY", "Internal request capacity exceeded", {
      retryable: true,
    });
    return false;
  }
  if (result.reason === "replay") {
    sendError(reply, 409, "INTERNAL_REQUEST_REPLAYED", "Internal request was already processed", {
      retryable: false,
    });
    return false;
  }
  sendInternalAuthFailed(reply);
  return false;
}

function isNodeAllowed(allowedNodes: Map<string, Set<number>> | undefined, nodeId: string, teamId: number): boolean {
  if (!allowedNodes || allowedNodes.size === 0) return false;
  const allowedTeamIds = allowedNodes.get(nodeId);
  return Boolean(allowedTeamIds?.has(teamId));
}

function parseRealtimePublishInput(rawBody: string): RealtimePublishInput {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Realtime event must be an object");
  }
  return parsed as unknown as RealtimePublishInput;
}

function enforceIdempotency(input: RealtimePublishInput, eventKey: string | undefined, reply: FastifyReply): boolean {
  const bodyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0
    ? input.idempotencyKey
    : undefined;
  if (input.replayable === true && bodyKey === undefined) {
    sendError(reply, 400, "INTERNAL_REALTIME_IDEMPOTENCY_REQUIRED", "Replayable realtime events require idempotencyKey", { retryable: false });
    return false;
  }
  if (bodyKey !== undefined && bodyKey !== eventKey) {
    sendError(reply, 400, "INTERNAL_REALTIME_IDEMPOTENCY_REQUIRED", "idempotency-key must match realtime event idempotencyKey", { retryable: false });
    return false;
  }
  return true;
}

function validateRealtimeInput(input: RealtimePublishInput): void {
  const envelope = createRealtimeEnvelope(input);
  if (envelope.type === "metrics.execution.snapshot") validateExecutionMetricsEnvelope(envelope);
  if (
    envelope.scope.kind === "team"
    && envelope.subject?.teamId !== undefined
    && envelope.subject.teamId !== null
    && envelope.subject.teamId !== envelope.scope.teamId
  ) {
    throw new Error("subject.teamId must match scope.teamId");
  }
}

function enforceScope(input: RealtimePublishInput, nodeId: string, options: InternalRealtimeControllerOptions, reply: FastifyReply): boolean {
  if (input.source.nodeId !== nodeId) {
    sendError(reply, 403, "INTERNAL_REALTIME_SCOPE_FORBIDDEN", "Signing node does not match event source", { retryable: false });
    return false;
  }

  if (options.adminPublishers?.has(nodeId)) return true;

  if (input.scope.kind === "admin") {
    sendError(reply, 403, "INTERNAL_REALTIME_SCOPE_FORBIDDEN", "Node is not allowed to publish admin realtime events", { retryable: false });
    return false;
  }

  if (!isNodeAllowed(options.allowedNodes, nodeId, input.scope.teamId)) {
    sendError(reply, 403, "INTERNAL_REALTIME_SCOPE_FORBIDDEN", "Node is not allowed to publish for this team", { retryable: false });
    return false;
  }
  return true;
}

function publishFailureDetails(error: unknown): { retryable: boolean } {
  if (typeof error === "object" && error !== null && "retryable" in error && typeof error.retryable === "boolean") {
    return { retryable: error.retryable };
  }
  return { retryable: true };
}

export const internalRealtimeController: FastifyPluginAsync<InternalRealtimeControllerOptions> = async (app, options) => {
  const publisher = options.publisher ?? createPersistentInProcessRealtimePublisher();
  const replayGuard = options.replayGuard ?? new InternalRequestReplayGuard();

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const nodeId = firstHeader(request.headers["x-spx-node-id"]);
    const timestamp = firstHeader(request.headers["x-spx-timestamp"]);
    const signature = firstHeader(request.headers["x-spx-signature"]);
    const eventKey = firstHeader(request.headers["idempotency-key"]);
    const requestId = firstHeader(request.headers["x-spx-request-id"]);

    if (!nodeId || !timestamp || !signature || !requestId) {
      return sendInternalAuthFailed(reply);
    }

    const authenticated = verifyNodeSignature({
      body: rawBody,
      timestamp,
      nodeId,
      signature,
      eventKey,
      requestId,
    }, options, () => {
      app.log.warn({ nodeId, boundary: "realtime-events" }, "internal-hmac-previous-key-used");
    });
    if (!authenticated) {
      return sendInternalAuthFailed(reply);
    }

    let input: RealtimePublishInput;
    try {
      input = parseRealtimePublishInput(rawBody);
      if (!enforceIdempotency(input, eventKey, reply)) return;
      validateRealtimeInput(input);
    } catch (error) {
      return sendInvalidRealtime(reply, error);
    }

    if (!enforceScope(input, nodeId, options, reply)) return;
    if (!await consumeRequest(replayGuard, { nodeId, requestId, timestamp }, reply)) return;

    try {
      const result = await publisher.publish(input);
      return sendSuccess(reply, result);
    } catch (error) {
      return sendError(
        reply,
        503,
        "INTERNAL_REALTIME_PUBLISH_FAILED",
        "Realtime publish failed",
        publishFailureDetails(error),
      );
    }
  });
};
