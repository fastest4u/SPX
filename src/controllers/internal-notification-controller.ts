import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createNotificationEventAndOutbox } from "../repositories/notification-repository.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import { verifyInternalSignature } from "../services/internal-auth.js";
import { metrics, type MetricsSnapshot } from "../services/metrics.js";
import { normalizeNotificationEvent, type NormalizedNotificationEvent, type NotificationEventInput } from "../services/notification-events.js";
import { recordRuntimeMetricsSnapshot, runtimeMetricsSnapshotFor } from "../services/runtime-metrics.js";
import { sseBroadcaster } from "../services/sse.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalNotificationControllerOptions {
  sharedSecret: string;
  allowedNodes?: Map<string, Set<number>>;
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

function isNodeAllowed(allowedNodes: Map<string, Set<number>> | undefined, nodeId: string, teamId: number): boolean {
  if (!allowedNodes || allowedNodes.size === 0) return true;
  const allowedTeamIds = allowedNodes.get(nodeId);
  return Boolean(allowedTeamIds?.has(teamId));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
  return parsed as unknown as MetricsSnapshot;
}

export const internalNotificationController: FastifyPluginAsync<InternalNotificationControllerOptions> = async (app, options) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/notification-events", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const nodeId = firstHeader(request.headers["x-spx-node-id"]);
    const timestamp = firstHeader(request.headers["x-spx-timestamp"]);
    const signature = firstHeader(request.headers["x-spx-signature"]);
    const eventKey = firstHeader(request.headers["idempotency-key"]);

    if (!nodeId || !timestamp || !signature || !eventKey) {
      return sendInternalAuthFailed(reply);
    }

    const authResult = verifyInternalSignature({
      body: rawBody,
      timestamp,
      nodeId,
      path: notificationEventsPath,
      secret: options.sharedSecret,
      signature,
      eventKey,
    });
    if (!authResult.ok) {
      return sendInternalAuthFailed(reply);
    }

    let body: NotificationEventInput;
    try {
      body = JSON.parse(rawBody) as NotificationEventInput;
    } catch (error) {
      return sendInvalidNotification(reply, error);
    }

    if (Number.isInteger(body.teamId) && !isNodeAllowed(options.allowedNodes, nodeId, body.teamId)) {
      return sendError(reply, 403, "INTERNAL_NODE_TEAM_FORBIDDEN", "Node is not allowed to publish for this team");
    }

    let event: NormalizedNotificationEvent;
    try {
      event = normalizeNotificationEvent(body, nodeId, eventKey);
    } catch (error) {
      return sendInvalidNotification(reply, error);
    }

    const team = await getTeamRuntimeConfig(event.teamId);
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
      title: event.eventType,
      message: event.payload.message,
    });
    return sendSuccess(reply, result);
  });

  app.post("/runtime-metrics", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const nodeId = firstHeader(request.headers["x-spx-node-id"]);
    const timestamp = firstHeader(request.headers["x-spx-timestamp"]);
    const signature = firstHeader(request.headers["x-spx-signature"]);

    if (!nodeId || !timestamp || !signature) {
      return sendInternalAuthFailed(reply);
    }

    const authResult = verifyInternalSignature({
      body: rawBody,
      timestamp,
      nodeId,
      path: runtimeMetricsPath,
      secret: options.sharedSecret,
      signature,
    });
    if (!authResult.ok) {
      return sendInternalAuthFailed(reply);
    }

    let snapshot: MetricsSnapshot;
    try {
      snapshot = parseMetricsSnapshot(rawBody);
    } catch (error) {
      return sendError(reply, 400, "INTERNAL_RUNTIME_METRICS_INVALID", error instanceof Error ? error.message : "Invalid runtime metrics");
    }

    if (typeof snapshot.teamId === "number" && !isNodeAllowed(options.allowedNodes, nodeId, snapshot.teamId)) {
      return sendError(reply, 403, "INTERNAL_NODE_TEAM_FORBIDDEN", "Node is not allowed to publish for this team");
    }

    const record = recordRuntimeMetricsSnapshot({ nodeId, snapshot });
    sseBroadcaster.broadcast({ event: "metrics", teamId: snapshot.teamId as number, data: snapshot });
    sseBroadcaster.broadcastAdmin({
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
