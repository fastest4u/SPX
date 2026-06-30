import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createNotificationEventAndOutbox } from "../repositories/notification-repository.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import { verifyInternalSignature } from "../services/internal-auth.js";
import { normalizeNotificationEvent, type NormalizedNotificationEvent, type NotificationEventInput } from "../services/notification-events.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalNotificationControllerOptions {
  sharedSecret: string;
  allowedNodes?: Map<string, Set<number>>;
}

const notificationEventsPath = "/internal/notification-events";

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
};
