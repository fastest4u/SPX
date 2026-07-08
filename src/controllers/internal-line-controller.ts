import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  LINE_INTERNAL_GROUPS_PATH,
  LINE_INTERNAL_LOGIN_PATH,
  LINE_INTERNAL_LOGOUT_PATH,
  LINE_INTERNAL_PROFILE_PATH,
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STORAGE_PATH,
  LINE_INTERNAL_STATUS_PATH,
  type LineServiceGroupsResponse,
  type LineServiceLoginResponse,
  type LineServiceLogoutRequest,
  type LineServiceLogoutResponse,
  type LineServiceProfileResponse,
  type LineServiceSendRequest,
  type LineServiceSendResponse,
  type LineServiceStorageResponse,
  type LineServiceStatusResponse,
} from "../services/line-service-contract.js";
import { verifyInternalSignature } from "../services/internal-auth.js";
import {
  getNotificationOutboxDeliveryState,
  markNotificationDeliveredAfterProviderSend,
} from "../repositories/notification-repository.js";
import type {
  LineBotProfile,
  LineBotSendResult,
  LineBotStatus,
  LineBotStorageHealth,
} from "../services/line-bot.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalLineServiceDependencies {
  isEnabled(): boolean;
  getStatus(): LineBotStatus;
  sendMessage(targetId: string, text: string): Promise<LineBotSendResult>;
  requestQrLogin(): Promise<LineBotStatus>;
  getGroups(): Promise<LineServiceGroupsResponse>;
  getProfile(): Promise<LineBotProfile | null>;
  getStorageHealth(): Promise<LineBotStorageHealth>;
  logout(clearStorage?: boolean): Promise<void>;
}

export interface InternalLineControllerOptions {
  sharedSecret: string;
  adminSharedSecret: string;
  line: InternalLineServiceDependencies;
  isListenerActive?: () => boolean;
}

const MAX_DEDUPED_OUTBOX_IDS = 10_000;
const sentOutboxIds = new Set<string>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendInternalAuthFailed(reply: FastifyReply): void {
  sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed");
}

function sendInvalidLineRequest(reply: FastifyReply, error: unknown): void {
  sendError(
    reply,
    400,
    "INTERNAL_LINE_INVALID",
    error instanceof Error ? error.message : "Invalid LINE service request",
  );
}

function verifySignedRequest(input: {
  request: FastifyRequest;
  rawBody: string;
  path: string;
  sharedSecret: string;
}): { ok: true; nodeId: string } | { ok: false } {
  const nodeId = firstHeader(input.request.headers["x-spx-node-id"]);
  const timestamp = firstHeader(input.request.headers["x-spx-timestamp"]);
  const signature = firstHeader(input.request.headers["x-spx-signature"]);
  const eventKey = firstHeader(input.request.headers["idempotency-key"]);

  if (!nodeId || !timestamp || !signature) return { ok: false };

  const authResult = verifyInternalSignature({
    body: input.rawBody,
    timestamp,
    nodeId,
    path: input.path,
    secret: input.sharedSecret,
    signature,
    eventKey,
  });
  return authResult.ok ? { ok: true, nodeId } : { ok: false };
}

function sentOutboxDedupeKey(outboxId: number | undefined, traceId: string | undefined): string | null {
  if (!outboxId) return null;
  return `${outboxId}:${traceId ?? ""}`;
}

function rememberSentOutboxId(outboxId: number | undefined, traceId: string | undefined): void {
  const key = sentOutboxDedupeKey(outboxId, traceId);
  if (!key) return;
  sentOutboxIds.add(key);
  if (sentOutboxIds.size > MAX_DEDUPED_OUTBOX_IDS) {
    const oldest = sentOutboxIds.values().next().value as string | undefined;
    if (oldest !== undefined) sentOutboxIds.delete(oldest);
  }
}

function hasSentOutboxId(outboxId: number | undefined, traceId: string | undefined): boolean {
  const key = sentOutboxDedupeKey(outboxId, traceId);
  return Boolean(key && sentOutboxIds.has(key));
}

function sentResponse(): LineServiceSendResponse {
  return {
    sent: true,
    provider: "linejs",
  };
}

function parseSendRequest(rawBody: string): LineServiceSendRequest {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed)) throw new Error("LINE send request must be an object");

  const targetId = parsed.targetId;
  const text = parsed.text;
  if (typeof targetId !== "string" || targetId.trim() === "") {
    throw new Error("targetId must be a non-empty string");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("text must be a non-empty string");
  }
  if (targetId.length > 255) throw new Error("targetId is too long");
  if (text.length > 5000) throw new Error("text is too long");

  const request: LineServiceSendRequest = {
    targetId,
    text,
  };
  if (typeof parsed.traceId === "string" && parsed.traceId.trim()) request.traceId = parsed.traceId;
  if (Number.isInteger(parsed.outboxId) && (parsed.outboxId as number) > 0) {
    request.outboxId = parsed.outboxId as number;
  }
  return request;
}

function parseLogoutRequest(rawBody: string): LineServiceLogoutRequest {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed)) throw new Error("LINE logout request must be an object");
  if ("clearStorage" in parsed && typeof parsed.clearStorage !== "boolean") {
    throw new Error("clearStorage must be a boolean");
  }
  return {
    clearStorage: typeof parsed.clearStorage === "boolean" ? parsed.clearStorage : undefined,
  };
}

function retryableUnavailable(
  reply: FastifyReply,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendError(reply, 503, code, message, {
    retryable: true,
    ...details,
  });
}

export const internalLineController: FastifyPluginAsync<InternalLineControllerOptions> = async (
  app,
  options,
) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/line/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_SEND_PATH,
      sharedSecret: options.sharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let body: LineServiceSendRequest;
    try {
      body = parseSendRequest(rawBody);
    } catch (error) {
      return sendInvalidLineRequest(reply, error);
    }

    if (!options.line.isEnabled()) {
      return retryableUnavailable(reply, "LINE_SERVICE_UNAVAILABLE", "LINE service is unavailable");
    }

    if (hasSentOutboxId(body.outboxId, body.traceId)) {
      return sendSuccess(reply, sentResponse());
    }

    if (body.outboxId) {
      let state: "missing" | "pending" | "sent";
      try {
        state = await getNotificationOutboxDeliveryState(body.outboxId);
      } catch (error) {
        return retryableUnavailable(
          reply,
          "LINE_SEND_DEDUPE_CHECK_FAILED",
          error instanceof Error ? error.message : "LINE send dedupe check failed",
        );
      }
      if (state === "sent") {
        rememberSentOutboxId(body.outboxId, body.traceId);
        return sendSuccess(reply, sentResponse());
      }
    }

    let result: LineBotSendResult;
    try {
      result = await options.line.sendMessage(body.targetId, body.text);
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_SEND_FAILED",
        error instanceof Error ? error.message : "LINE send failed",
      );
    }

    if (!result.ok) {
      return retryableUnavailable(reply, "LINE_SEND_FAILED", result.error || "LINE send failed", {
        qrRequired: Boolean(result.qrUrl || result.pincode),
      });
    }

    rememberSentOutboxId(body.outboxId, body.traceId);
    if (body.outboxId) {
      try {
        await markNotificationDeliveredAfterProviderSend(body.outboxId, authResult.nodeId, "linejs");
      } catch {
        // The caller still marks the shared outbox row after this successful response.
      }
    }

    return sendSuccess(reply, sentResponse());
  });

  app.post("/line/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_STATUS_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let status: LineBotStatus;
    try {
      status = options.line.getStatus();
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_STATUS_FAILED",
        error instanceof Error ? error.message : "LINE status failed",
      );
    }

    const response: LineServiceStatusResponse = {
      enabled: status.enabled,
      authenticated: status.authenticated,
      listenerActive: options.isListenerActive?.() ?? false,
    };
    if (status.qrUrl) response.qrUrl = status.qrUrl;
    if (status.pincode) response.pincode = status.pincode;
    return sendSuccess(reply, response);
  });

  app.post("/line/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_LOGIN_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let status: LineBotStatus;
    try {
      status = await options.line.requestQrLogin();
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_LOGIN_FAILED",
        error instanceof Error ? error.message : "LINE login failed",
      );
    }

    const response: LineServiceLoginResponse = {
      enabled: status.enabled,
      authenticated: status.authenticated,
      listenerActive: options.isListenerActive?.() ?? false,
      message: status.message,
    };
    if (status.qrUrl) response.qrUrl = status.qrUrl;
    if (status.pincode) response.pincode = status.pincode;
    return sendSuccess(reply, response);
  });

  app.post("/line/groups", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_GROUPS_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    try {
      const response = await options.line.getGroups();
      return sendSuccess(reply, response);
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_GROUPS_FAILED",
        error instanceof Error ? error.message : "LINE groups failed",
      );
    }
  });

  app.post("/line/profile", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_PROFILE_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let profile: LineBotProfile | null;
    try {
      profile = await options.line.getProfile();
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_PROFILE_FAILED",
        error instanceof Error ? error.message : "LINE profile failed",
      );
    }
    if (!profile) {
      return retryableUnavailable(
        reply,
        "LINE_PROFILE_UNAVAILABLE",
        "LINE Bot is not authenticated or profile unavailable",
      );
    }

    const response: LineServiceProfileResponse = {
      displayName: profile.displayName,
      mid: profile.mid,
    };
    if (profile.statusMessage) response.statusMessage = profile.statusMessage;
    if (profile.pictureUrl) response.pictureUrl = profile.pictureUrl;
    return sendSuccess(reply, response);
  });

  app.post("/line/storage", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_STORAGE_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let storage: LineBotStorageHealth;
    try {
      storage = await options.line.getStorageHealth();
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_STORAGE_FAILED",
        error instanceof Error ? error.message : "LINE storage health failed",
      );
    }

    const response: LineServiceStorageResponse = {
      storagePath: storage.storagePath,
      exists: storage.exists,
      sizeBytes: storage.sizeBytes,
      hasE2EEKeys: storage.hasE2EEKeys,
      hasAuthState: storage.hasAuthState,
    };
    return sendSuccess(reply, response);
  });

  app.post("/line/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: LINE_INTERNAL_LOGOUT_PATH,
      sharedSecret: options.adminSharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let body: LineServiceLogoutRequest;
    try {
      body = parseLogoutRequest(rawBody);
    } catch (error) {
      return sendInvalidLineRequest(reply, error);
    }

    try {
      await options.line.logout(body.clearStorage);
    } catch (error) {
      return retryableUnavailable(
        reply,
        "LINE_LOGOUT_FAILED",
        error instanceof Error ? error.message : "LINE logout failed",
      );
    }

    const response: LineServiceLogoutResponse = {
      loggedOut: true,
      clearStorage: Boolean(body.clearStorage),
    };
    return sendSuccess(reply, response);
  });
};
