import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createNotificationEventAndOutbox } from "../repositories/notification-repository.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import {
  InternalRequestReplayGuard,
  type InternalRequestReplayStore,
  type NodeSecretKeyRing,
  verifyInternalNodeSignature,
  verifyInternalSignature,
} from "../services/internal-auth.js";
import { metrics, type MetricsSnapshot } from "../services/metrics.js";
import { normalizeNotificationEvent, type NormalizedNotificationEvent, type NotificationEventInput } from "../services/notification-events.js";
import { normalizeRuntimeMetricsSnapshot, recordRuntimeMetricsSnapshot, runtimeMetricsSnapshotFor } from "../services/runtime-metrics.js";
import { createInProcessRealtimePublisher, type LegacyRealtimeEvent } from "../services/realtime-publisher.js";
import type { RealtimePublisher } from "../services/realtime-contract.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalNotificationControllerOptions {
  sharedSecret?: string;
  allowedNodes?: Map<string, Set<number>>;
  realtimePublisher?: RealtimePublisher;
  nodeSecrets?: ReadonlyMap<string, NodeSecretKeyRing>;
  replayGuard?: InternalRequestReplayStore;
}

const notificationEventsPath = "/internal/notification-events";
const runtimeMetricsPath = "/internal/runtime-metrics";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendInternalAuthFailed(reply: FastifyReply): void {
  sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed");
}

function sendInvalidNotification(reply: FastifyReply, error: unknown): void {
  sendError(
    reply,
    400,
    "INTERNAL_NOTIFICATION_INVALID",
    error instanceof Error ? error.message : "Invalid notification event",
  );
}

interface AuthenticatedNotificationRequest {
  nodeId: string;
  requestId?: string;
  timestamp: string;
}

function authenticateInternalRequest(input: {
  eventKey?: string;
  options: InternalNotificationControllerOptions;
  path: string;
  rawBody: string;
  request: FastifyRequest;
  onPreviousKeyUsed: (nodeId: string) => void;
}): AuthenticatedNotificationRequest | null {
  const nodeId = firstHeader(input.request.headers["x-spx-node-id"]);
  const timestamp = firstHeader(input.request.headers["x-spx-timestamp"]);
  const signature = firstHeader(input.request.headers["x-spx-signature"]);
  const requestId = firstHeader(input.request.headers["x-spx-request-id"]);
  if (!nodeId || !timestamp || !signature) return null;

  if (input.options.nodeSecrets?.size) {
    if (!requestId) return null;
    const verified = verifyInternalNodeSignature({
      body: input.rawBody,
      timestamp,
      nodeId,
      path: input.path,
      nodeSecrets: input.options.nodeSecrets,
      signature,
      eventKey: input.eventKey,
      requestId,
      onKeyGeneration: (generation) => {
        if (generation === "previous") input.onPreviousKeyUsed(nodeId);
      },
    });
    return verified.ok ? { nodeId, requestId, timestamp } : null;
  }

  const secret = input.options.sharedSecret;
  if (typeof secret !== "string" || secret.trim() === "") return null;
  const verified = verifyInternalSignature({
    body: input.rawBody,
    timestamp,
    nodeId,
    path: input.path,
    secret,
    signature,
    eventKey: input.eventKey,
    requestId,
  });
  return verified.ok ? { nodeId, requestId, timestamp } : null;
}

async function consumeInternalRequest(input: {
  authenticated: AuthenticatedNotificationRequest;
  partition: "notification-events" | "runtime-metrics";
  replayGuard: InternalRequestReplayStore;
  reply: FastifyReply;
}): Promise<boolean> {
  if (!input.authenticated.requestId) return true;
  const replay = await input.replayGuard.consume({
    nodeId: input.authenticated.nodeId,
    requestId: input.authenticated.requestId,
    signedTimestamp: input.authenticated.timestamp,
    partition: input.partition,
  });
  if (replay.ok) return true;
  if (replay.reason === "capacity") {
    sendError(input.reply, 429, "INTERNAL_REPLAY_CAPACITY", "Internal request capacity exceeded", {
      retryable: true,
    });
  } else if (replay.reason === "replay") {
    sendError(input.reply, 409, "INTERNAL_REPLAY_DETECTED", "Internal request was already processed", {
      retryable: false,
    });
  } else {
    sendInternalAuthFailed(input.reply);
  }
  return false;
}

function isNodeAllowed(allowedNodes: Map<string, Set<number>> | undefined, nodeId: string, teamId: number): boolean {
  if (!allowedNodes || allowedNodes.size === 0) return true;
  const allowedTeamIds = allowedNodes.get(nodeId);
  return Boolean(allowedTeamIds?.has(teamId));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function notificationOutboxTitle(event: NormalizedNotificationEvent): string {
  if (event.eventType === "auto_accept_result" && event.payload.status === "owned") {
    return `✅ SPX Auto-Accept สำเร็จ ${event.payload.requestIds?.length ?? 0} รายการ`;
  }
  return event.eventType;
}

function parseMetricsSnapshot(rawBody: string): MetricsSnapshot {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed)) throw new Error("Runtime metrics snapshot must be an object");
  if (!Number.isInteger(parsed.teamId) || (parsed.teamId as number) <= 0) {
    throw new Error("Runtime metrics snapshot must include a positive teamId");
  }
  for (const key of ["polling", "data", "autoAccept", "operations", "runtime"] as const) {
    if (!isObject(parsed[key])) throw new Error(`Runtime metrics snapshot missing ${key}`);
  }
  return normalizeRuntimeMetricsSnapshot(parsed);
}

export const internalNotificationController: FastifyPluginAsync<InternalNotificationControllerOptions> = async (app, options) => {
  const realtimePublisher = options.realtimePublisher ?? createInProcessRealtimePublisher();
  const replayGuard = options.replayGuard ?? new InternalRequestReplayGuard();
  const onPreviousKeyUsed = (nodeId: string) => {
    app.log.warn({ nodeId, boundary: "notification" }, "internal-hmac-previous-key-used");
  };
  const publishLegacy = (event: LegacyRealtimeEvent): void => {
    try {
      (realtimePublisher as RealtimePublisher & {
        publishLegacy?: (event: LegacyRealtimeEvent) => void;
      }).publishLegacy?.(event);
    } catch {
      // Legacy fan-out is best-effort; durable state was already recorded.
    }
  };
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/notification-events", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const eventKey = firstHeader(request.headers["idempotency-key"]);

    if (!eventKey) {
      return sendInternalAuthFailed(reply);
    }
    const authenticated = authenticateInternalRequest({
      eventKey,
      options,
      path: notificationEventsPath,
      rawBody,
      request,
      onPreviousKeyUsed,
    });
    if (!authenticated) {
      return sendInternalAuthFailed(reply);
    }

    let body: NotificationEventInput;
    try {
      body = JSON.parse(rawBody) as NotificationEventInput;
    } catch (error) {
      return sendInvalidNotification(reply, error);
    }

    if (Number.isInteger(body.teamId) && !isNodeAllowed(options.allowedNodes, authenticated.nodeId, body.teamId)) {
      return sendError(reply, 403, "INTERNAL_NODE_TEAM_FORBIDDEN", "Node is not allowed to publish for this team");
    }

    let event: NormalizedNotificationEvent;
    try {
      event = normalizeNotificationEvent(body, authenticated.nodeId, eventKey);
    } catch (error) {
      return sendInvalidNotification(reply, error);
    }
    if (!await consumeInternalRequest({
      authenticated,
      partition: "notification-events",
      replayGuard,
      reply,
    })) return;

    const team = await getTeamRuntimeConfig(event.teamId);
    if (event.eventType.startsWith("rate_limit_") && !team?.rateLimitNotifyEnabled) {
      return sendSuccess(reply, { ignored: true, reason: "rate_limit_notify_disabled" });
    }
    const lineGroupId = event.eventType === "auto_accept_failure"
      ? (team?.autoAcceptFailureLineGroupId || team?.lineGroupId || "").trim()
      : event.eventType === "auto_accept_result" || event.eventType === "auto_accept_partial_result"
        ? (team?.autoAcceptSuccessLineGroupId || team?.lineGroupId || "").trim()
        : (team?.lineGroupId || "").trim();
    if (!lineGroupId) {
      return sendError(reply, 422, "INTERNAL_NOTIFICATION_TARGET_MISSING", "Team LINE target is not configured");
    }

    const result = await createNotificationEventAndOutbox(event, {
      targetType: "line_group",
      targetId: lineGroupId,
      title: notificationOutboxTitle(event),
      message: event.payload.message,
    });
    return sendSuccess(reply, result);
  });

  app.post("/runtime-metrics", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authenticated = authenticateInternalRequest({
      options,
      path: runtimeMetricsPath,
      rawBody,
      request,
      onPreviousKeyUsed,
    });
    if (!authenticated) {
      return sendInternalAuthFailed(reply);
    }

    let snapshot: MetricsSnapshot;
    try {
      snapshot = parseMetricsSnapshot(rawBody);
    } catch (error) {
      return sendError(reply, 400, "INTERNAL_RUNTIME_METRICS_INVALID", error instanceof Error ? error.message : "Invalid runtime metrics");
    }

    if (typeof snapshot.teamId === "number" && !isNodeAllowed(options.allowedNodes, authenticated.nodeId, snapshot.teamId)) {
      return sendError(reply, 403, "INTERNAL_NODE_TEAM_FORBIDDEN", "Node is not allowed to publish for this team");
    }
    if (!await consumeInternalRequest({
      authenticated,
      partition: "runtime-metrics",
      replayGuard,
      reply,
    })) return;

    const record = recordRuntimeMetricsSnapshot({ nodeId: authenticated.nodeId, snapshot });
    publishLegacy({ event: "metrics", teamId: snapshot.teamId as number, data: snapshot });
    publishLegacy({
      event: "metrics",
      data: runtimeMetricsSnapshotFor(metrics.snapshot(), null),
    });
    return sendSuccess(reply, {
      nodeId: record.nodeId,
      teamId: snapshot.teamId,
      receivedAt: new Date(record.receivedAt).toISOString(),
    });
  });
};
