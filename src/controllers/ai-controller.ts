import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import {
  DEFAULT_CODEX_IMAGE_PROMPT,
  extensionForMimeType,
  isSupportedImageMimeType,
  readImageWithCodex,
} from "../services/codex-image-reader.js";
import {
  clearCodexDeviceAuth,
  completeCodexBrowserAuth,
  getCodexDeviceAuthStatus,
  startCodexBrowserAuth,
  startDeviceCodeAuth,
} from "../services/codex-device-auth.js";
import { sendError, sendSuccess } from "../utils/response.js";
import {
  OCR_INTERNAL_ADMIN_COMPLETE_PATH,
  OCR_INTERNAL_ADMIN_LOGOUT_PATH,
  OCR_INTERNAL_ADMIN_START_PATH,
  OCR_INTERNAL_ADMIN_STATUS_PATH,
  type OcrAdminCommand,
} from "../services/ocr-service-admin-contract.js";
import { resolveOutboundNodeSecret } from "../services/notification-publisher.js";
import { createInternalSignature } from "../services/internal-auth.js";
import { randomUUID } from "node:crypto";
import type { OcrAuthAction, OcrAuthRateLimitResult } from "../services/ocr-auth-rate-limit.js";

export interface AiOcrAuthRateLimiter {
  consume(input: {
    action: OcrAuthAction;
    actorUserId: number;
    clientIp: string;
  }): OcrAuthRateLimitResult;
}

export interface AiOcrAuthService {
  getStatus(): Promise<Record<string, unknown> & { authenticated: boolean }>;
  startBrowser(): Promise<Record<string, unknown>>;
  startDevice(): Promise<Record<string, unknown>>;
  complete(input: string): Promise<Record<string, unknown>>;
  logout(): Promise<void>;
}

export interface OcrAuthAuditEvent {
  userId: number;
  username: string;
  action: string;
  metadata?: Record<string, unknown>;
}

export interface AiControllerOptions {
  authRateLimiter?: AiOcrAuthRateLimiter;
  auditWriter?: (input: OcrAuthAuditEvent) => Promise<void>;
  authService?: AiOcrAuthService;
}

/**
 * Forwards a signed admin OCR auth command to the configured ocr-service.
 * The request binds the node identity, a fresh request id, and the exact
 * admin path so replay or cross-service reuse fails signature verification.
 */
async function postOcrAdminCommand<TData>(command: OcrAdminCommand): Promise<TData> {
  const origin = env.OCR_SERVICE_URL.trim().replace(/\/+$/, "");
  const body = JSON.stringify(command);
  const timestamp = new Date().toISOString();
  const requestId = randomUUID();
  const path = command.kind === "status"
    ? OCR_INTERNAL_ADMIN_STATUS_PATH
    : command.kind === "start"
      ? OCR_INTERNAL_ADMIN_START_PATH
      : command.kind === "complete"
        ? OCR_INTERNAL_ADMIN_COMPLETE_PATH
        : OCR_INTERNAL_ADMIN_LOGOUT_PATH;
  const { secret } = resolveOutboundNodeSecret({
    nodeSecret: env.OCR_NODE_SECRET,
    legacySharedSecret: env.OCR_SERVICE_ADMIN_SECRET,
    nodeEnv: env.NODE_ENV,
    deploymentMode: env.DEPLOYMENT_MODE,
  });
  const signature = createInternalSignature({
    body,
    timestamp,
    nodeId: env.SPX_NODE_ID || "web-api",
    path,
    secret,
    requestId,
  });
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spx-node-id": env.SPX_NODE_ID || "web-api",
      "x-spx-timestamp": timestamp,
      "x-spx-request-id": requestId,
      "x-spx-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(env.OCR_SERVICE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OCR admin command failed with status ${response.status}`);
  const payload = (await response.json()) as { data?: TData };
  if (!payload || typeof payload !== "object" || payload.data === undefined) {
    throw new Error("OCR admin command returned no data");
  }
  return payload.data;
}

function localAuthStatus(): Promise<Record<string, unknown> & { authenticated: boolean }> {
  return getCodexDeviceAuthStatus().then(({ authPath: _authPath, ...status }) => status);
}

function createDefaultAuthService(): AiOcrAuthService {
  if (env.OCR_SERVICE_URL.trim() !== "") {
    return {
      getStatus: () => postOcrAdminCommand({ kind: "status" }),
      startBrowser: () => postOcrAdminCommand({ kind: "start", mode: "browser" }),
      startDevice: () => postOcrAdminCommand({ kind: "start", mode: "device" }),
      complete: (input) => postOcrAdminCommand({ kind: "complete", input }),
      logout: async () => {
        await postOcrAdminCommand({ kind: "logout" });
      },
    };
  }
  return {
    getStatus: localAuthStatus,
    startBrowser: startCodexBrowserAuth,
    startDevice: startDeviceCodeAuth,
    complete: completeCodexBrowserAuth,
    logout: clearCodexDeviceAuth,
  };
}

interface ReadImageQuery {
  prompt?: string;
  model?: string;
}

interface ReadImageResponse {
  text: string;
  model: string | null;
}

interface CompleteCodexAuthBody {
  callbackUrl?: string;
  code?: string;
}

interface StartCodexAuthBody {
  mode?: "browser" | "device";
}

const startCodexAuthSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["browser", "device"] },
  },
} as const;

const completeCodexAuthSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    callbackUrl: { type: "string" },
    code: { type: "string" },
  },
} as const;

function getMultipartFieldValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if ("value" in value && typeof value.value === "string") {
    return value.value;
  }

  return undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getCodexAuthStartFailure(error: unknown): { statusCode: number; errorCode: string; message: string } {
  const message = getErrorMessage(error, "Codex OAuth login failed.");
  const providerUnavailable = /\b5\d\d\b|INTERNAL_SERVER_ERROR|Internal server error|server_error|fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(message);

  if (providerUnavailable) {
    return {
      statusCode: 503,
      errorCode: "CODEX_AUTH_PROVIDER_UNAVAILABLE",
      message: "OpenAI/Codex login service is temporarily unavailable. Please try the selected login mode again later.",
    };
  }

  return {
    statusCode: 502,
    errorCode: "CODEX_AUTH_START_FAILED",
    message,
  };
}

function ocrActor(request: FastifyRequest): { userId: number; username: string } {
  const user = request.user as { id?: unknown; username?: unknown } | undefined;
  return {
    userId: Number(user?.id ?? 0),
    username: typeof user?.username === "string" ? user.username : "unknown",
  };
}

async function enforceOcrAuthRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  action: OcrAuthAction,
  options: AiControllerOptions,
): Promise<boolean> {
  if (!options.authRateLimiter) return true;
  const actor = ocrActor(request);
  const verdict = options.authRateLimiter.consume({
    action,
    actorUserId: actor.userId,
    clientIp: request.ip,
  });
  if (verdict.allowed) return true;

  reply.header("Retry-After", String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1_000))));
  if (verdict.shouldAudit) {
    await options.auditWriter?.({
      ...actor,
      action: "codex_auth_rate_limited",
      metadata: {
        requestedAction: action,
        limitingScope: verdict.limitingScope,
        resetAt: verdict.resetAt,
      },
    });
  }
  sendError(reply, 429, "RATE_LIMITED", "Too many OCR authentication requests", {
    retryAfterMs: verdict.retryAfterMs,
  });
  return false;
}

async function auditOcrAuthAction(
  request: FastifyRequest,
  action: OcrAuthAction,
  options: AiControllerOptions,
): Promise<void> {
  await options.auditWriter?.({
    ...ocrActor(request),
    action: `codex_auth_${action}`,
  });
}

export const aiController: FastifyPluginAsync<AiControllerOptions> = async (app, options) => {
  const authService = options.authService ?? createDefaultAuthService();

  app.get("/codex-auth/status", async (req, reply) => {
    if (!await enforceOcrAuthRateLimit(req, reply, "status", options)) return;
    try {
      const data = await authService.getStatus();
      await auditOcrAuthAction(req, "status", options);
      return sendSuccess(reply, data);
    } catch (error) {
      app.log.warn({ error: getErrorMessage(error, "ocr admin status failed") }, "ocr-admin-status-failed");
      return sendError(reply, 503, "OCR_ADMIN_UNAVAILABLE", "OCR admin status is unavailable.");
    }
  });

  app.post<{ Body: StartCodexAuthBody }>(
    "/codex-auth/start",
    { schema: { body: startCodexAuthSchema } },
    async (req, reply) => {
      if (!await enforceOcrAuthRateLimit(req, reply, "start", options)) return;
      try {
        const mode = req.body?.mode;
        if (!mode) {
          return sendError(reply, 400, "CODEX_AUTH_MODE_REQUIRED", "Choose a Codex auth mode: browser or device.");
        }

        const result = mode === "device"
          ? await authService.startDevice()
          : await authService.startBrowser();
        await auditOcrAuthAction(req, "start", options);
        return sendSuccess(reply, { ...result, mode }, `Codex ${mode} auth flow started`);
      } catch (error) {
        const failure = getCodexAuthStartFailure(error);
        app.log.warn({ error: getErrorMessage(error, failure.message), errorCode: failure.errorCode }, "codex-auth-start-failed");
        return sendError(reply, failure.statusCode, failure.errorCode, failure.message);
      }
    }
  );

  app.post<{ Body: CompleteCodexAuthBody }>(
    "/codex-auth/complete",
    { schema: { body: completeCodexAuthSchema } },
    async (req, reply) => {
      if (!await enforceOcrAuthRateLimit(req, reply, "complete", options)) return;
      const input = req.body.callbackUrl || req.body.code || "";
      if (!input.trim()) {
        return sendError(reply, 400, "CODEX_AUTH_INPUT_REQUIRED", "callbackUrl or code is required.");
      }
      try {
        const result = await authService.complete(input);
        await auditOcrAuthAction(req, "complete", options);
        return sendSuccess(reply, result, "Codex OAuth login completed");
      } catch (error) {
        return sendError(
          reply,
          400,
          "CODEX_AUTH_FAILED",
          getErrorMessage(error, "Codex OAuth login failed.")
        );
      }
    }
  );

  app.post("/codex-auth/logout", async (req, reply) => {
    if (!await enforceOcrAuthRateLimit(req, reply, "logout", options)) return;
    await authService.logout();
    await auditOcrAuthAction(req, "logout", options);
    return sendSuccess(reply, { loggedOut: true }, "Codex OAuth credentials cleared");
  });

  app.post<{ Querystring: ReadImageQuery }>("/read-image", async (req, reply) => {
    if (!req.isMultipart()) {
      return sendError(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "Use multipart/form-data with an image file field.");
    }

    const part = await req.file({ limits: { fileSize: env.CODEX_IMAGE_MAX_BYTES } });
    if (!part) {
      return sendError(reply, 400, "IMAGE_REQUIRED", "Image file is required.");
    }

    if (!isSupportedImageMimeType(part.mimetype)) {
      await part.file.resume();
      return sendError(reply, 415, "UNSUPPORTED_IMAGE_TYPE", "Supported image types are JPEG, PNG, and WebP.");
    }

    const tempDir = await mkdtemp(join(tmpdir(), "spx-codex-image-"));
    const imagePath = join(tempDir, `upload${extensionForMimeType(part.mimetype)}`);

    try {
      await pipeline(part.file, createWriteStream(imagePath, { flags: "wx" }));

      if (part.file.truncated) {
        return sendError(reply, 413, "IMAGE_TOO_LARGE", `Image must be ${env.CODEX_IMAGE_MAX_BYTES} bytes or smaller.`);
      }

      const prompt = req.query.prompt
        ?? getMultipartFieldValue(part.fields.prompt)
        ?? DEFAULT_CODEX_IMAGE_PROMPT;
      const model = req.query.model ?? getMultipartFieldValue(part.fields.model) ?? env.CODEX_IMAGE_MODEL;
      const text = await readImageWithCodex({
        imagePath,
        mimeType: part.mimetype,
        model,
        prompt,
        timeoutMs: env.CODEX_IMAGE_TIMEOUT_MS,
      });

      return sendSuccess<ReadImageResponse>(reply, { text, model: model.trim() || null }, "Image read successfully");
    } catch (error) {
      app.log.warn({ error: error instanceof Error ? error.message : String(error) }, "codex-image-read-failed");
      return sendError(reply, 502, "CODEX_IMAGE_READ_FAILED", "Image reading failed. Please try again.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
};
