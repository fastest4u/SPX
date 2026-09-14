import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_IMAGE_PROMPT, readImageWithCodex } from "../services/codex-image-reader.js";
import {
  InternalRequestReplayGuard,
  type InternalRequestReplayStore,
  type NodeSecretKeyRing,
  verifyInternalNodeSignature,
  verifyInternalSignature,
} from "../services/internal-auth.js";
import {
  readLineImageWithRetry,
  type LineImageReadResult,
} from "../services/line-image-extraction.js";
import {
  OCR_INTERNAL_READ_LINE_IMAGE_PATH,
  isOcrLineImageMimeType,
  type OcrLineImageMimeType,
  type OcrLineImageRequest,
  type OcrLineImageResponse,
} from "../services/ocr-service-contract.js";
import {
  OCR_INTERNAL_ADMIN_COMPLETE_PATH,
  OCR_INTERNAL_ADMIN_LOGOUT_PATH,
  OCR_INTERNAL_ADMIN_START_PATH,
  OCR_INTERNAL_ADMIN_STATUS_PATH,
  type OcrAdminCommand,
  type PublicOcrAuthStatus,
} from "../services/ocr-service-admin-contract.js";
import {
  clearCodexDeviceAuth,
  completeCodexBrowserAuth,
  getCodexDeviceAuthStatus,
  startCodexBrowserAuth,
  startDeviceCodeAuth,
} from "../services/codex-device-auth.js";
import { env } from "../config/env.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalOcrReadInput {
  imagePath: string;
  mimeType: OcrLineImageMimeType;
  prompt: string;
  timeoutMs: number;
}

export interface InternalOcrAuthService {
  getStatus(): Promise<{
    authenticated: boolean;
    expiresAt?: number | string;
    [key: string]: unknown;
  }>;
  startBrowser(): Promise<unknown>;
  startDevice(): Promise<unknown>;
  complete(input: string): Promise<unknown>;
  logout(): Promise<void>;
}

export interface InternalOcrControllerOptions {
  sharedSecret?: string;
  adminSharedSecret?: string;
  nodeSecrets?: ReadonlyMap<string, NodeSecretKeyRing>;
  readAllowedNodeIds?: ReadonlySet<string>;
  adminAllowedNodeIds?: ReadonlySet<string>;
  prompt?: string;
  timeoutMs?: number;
  readLineImage?: (input: InternalOcrReadInput) => Promise<LineImageReadResult>;
  authService?: InternalOcrAuthService;
  replayGuard?: InternalRequestReplayStore;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extensionForOcrMimeType(mimeType: OcrLineImageMimeType): ".jpg" | ".png" | ".webp" {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function sendInternalAuthFailed(reply: FastifyReply): void {
  sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", {
    retryable: false,
  });
}

function sendInternalForbidden(reply: FastifyReply): void {
  sendError(reply, 403, "INTERNAL_OCR_FORBIDDEN", "Node is not allowed for this OCR operation", {
    retryable: false,
  });
}

function sendInvalidOcrRequest(reply: FastifyReply, error: unknown): void {
  sendError(
    reply,
    400,
    "INTERNAL_OCR_INVALID",
    error instanceof Error ? error.message : "Invalid OCR request",
  );
}

function retryableUnavailable(reply: FastifyReply, message: string): void {
  sendError(reply, 503, "OCR_READ_FAILED", message, { retryable: true });
}

function retryableAdminUnavailable(reply: FastifyReply): void {
  sendError(reply, 503, "OCR_ADMIN_FAILED", "OCR admin operation failed", {
    retryable: true,
  });
}

interface AuthenticatedInternalRequest {
  nodeId: string;
  requestId?: string;
  timestamp: string;
}

function authenticateSignedRequest(input: {
  request: FastifyRequest;
  rawBody: string;
  path: string;
  access: "read" | "admin";
  options: InternalOcrControllerOptions;
  onPreviousKeyUsed: (nodeId: string) => void;
}): AuthenticatedInternalRequest | null {
  const nodeId = firstHeader(input.request.headers["x-spx-node-id"]);
  const timestamp = firstHeader(input.request.headers["x-spx-timestamp"]);
  const signature = firstHeader(input.request.headers["x-spx-signature"]);
  const eventKey = firstHeader(input.request.headers["idempotency-key"]);
  const requestId = firstHeader(input.request.headers["x-spx-request-id"]);

  if (!nodeId || !timestamp || !signature) return null;

  const nodeScoped = Boolean(input.options.nodeSecrets?.size);
  if (nodeScoped) {
    if (!requestId) return null;
    const authResult = verifyInternalNodeSignature({
      body: input.rawBody,
      timestamp,
      nodeId,
      path: input.path,
      nodeSecrets: input.options.nodeSecrets as ReadonlyMap<string, NodeSecretKeyRing>,
      signature,
      eventKey,
      requestId,
      onKeyGeneration: (generation) => {
        if (generation === "previous") input.onPreviousKeyUsed(nodeId);
      },
    });
    if (!authResult.ok) return null;
    const allowedNodeIds = input.access === "read"
      ? input.options.readAllowedNodeIds
      : input.options.adminAllowedNodeIds;
    if (!allowedNodeIds?.has(nodeId)) {
      return { nodeId, requestId: "", timestamp };
    }
    return { nodeId, requestId, timestamp };
  }

  const sharedSecret = input.access === "read"
    ? input.options.sharedSecret
    : input.options.adminSharedSecret;
  if (typeof sharedSecret !== "string" || sharedSecret.trim() === "") return null;
  const authResult = verifyInternalSignature({
    body: input.rawBody,
    timestamp,
    nodeId,
    path: input.path,
    secret: sharedSecret,
    signature,
    eventKey,
    requestId,
  });
  return authResult.ok ? { nodeId, requestId, timestamp } : null;
}

async function consumeRequest(
  replayGuard: InternalRequestReplayStore,
  authenticated: AuthenticatedInternalRequest,
  partition: "ocr-read" | "ocr-admin",
  reply: FastifyReply,
): Promise<boolean> {
  if (!authenticated.requestId) return true;
  const result = await replayGuard.consume({
    nodeId: authenticated.nodeId,
    requestId: authenticated.requestId,
    signedTimestamp: authenticated.timestamp,
    partition,
  });
  if (result.ok) return true;
  if (result.reason === "capacity") {
    sendError(reply, 429, "INTERNAL_REPLAY_CAPACITY", "Internal request capacity exceeded", {
      retryable: true,
    });
  } else if (result.reason === "replay") {
    sendError(reply, 409, "INTERNAL_REPLAY_DETECTED", "Internal request was already processed", {
      retryable: false,
    });
  } else {
    sendInternalAuthFailed(reply);
  }
  return false;
}

function parseLineImageRequest(rawBody: string): OcrLineImageRequest {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed)) throw new Error("OCR request must be an object");

  const imageBase64 = parsed.imageBase64;
  const mimeType = parsed.mimeType;
  const traceId = parsed.traceId;
  if (typeof imageBase64 !== "string" || imageBase64.trim() === "") {
    throw new Error("imageBase64 must be a non-empty string");
  }
  if (typeof mimeType !== "string" || !isOcrLineImageMimeType(mimeType)) {
    throw new Error("mimeType must be image/jpeg, image/png, or image/webp");
  }
  if (typeof traceId !== "string" || traceId.trim() === "") {
    throw new Error("traceId must be a non-empty string");
  }

  const decoded = Buffer.from(imageBase64, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== imageBase64.trim()) {
    throw new Error("imageBase64 must be valid base64");
  }
  if (decoded.byteLength > env.CODEX_IMAGE_MAX_BYTES) {
    throw new Error("imageBase64 exceeds CODEX_IMAGE_MAX_BYTES");
  }

  const request: OcrLineImageRequest = {
    imageBase64: imageBase64.trim(),
    mimeType,
    traceId,
  };
  if (typeof parsed.chatId === "string" && parsed.chatId.trim()) request.chatId = parsed.chatId;
  if (typeof parsed.senderId === "string" && parsed.senderId.trim())
    request.senderId = parsed.senderId;
  return request;
}

async function defaultReadLineImage(input: InternalOcrReadInput): Promise<LineImageReadResult> {
  return readLineImageWithRetry(
    (promptOverride) =>
      readImageWithCodex({
        imagePath: input.imagePath,
        mimeType: input.mimeType,
        prompt: promptOverride ?? input.prompt,
        timeoutMs: input.timeoutMs,
      }),
    input.prompt,
  );
}

function toOcrResponse(read: LineImageReadResult): OcrLineImageResponse {
  return {
    text: read.text,
    attempts: read.attempts,
    validation: read.validation.ok ? { ok: true } : { ok: false, reason: read.validation.reason },
  };
}

function parseAdminCommand(rawBody: string, expectedKind: OcrAdminCommand["kind"]): OcrAdminCommand {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed) || parsed.kind !== expectedKind) {
    throw new Error(`OCR admin command must have kind ${expectedKind}`);
  }
  if (expectedKind === "start") {
    if (parsed.mode !== "browser" && parsed.mode !== "device") {
      throw new Error("OCR admin start mode must be browser or device");
    }
    return { kind: "start", mode: parsed.mode };
  }
  if (expectedKind === "complete") {
    if (typeof parsed.input !== "string" || parsed.input.trim() === "") {
      throw new Error("OCR admin complete input must be a non-empty string");
    }
    return { kind: "complete", input: parsed.input };
  }
  return expectedKind === "status" ? { kind: "status" } : { kind: "logout" };
}

function publicAuthStatus(status: Awaited<ReturnType<InternalOcrAuthService["getStatus"]>>): PublicOcrAuthStatus {
  const expiresAtMs = typeof status.expiresAt === "number"
    ? status.expiresAt
    : typeof status.expiresAt === "string"
      ? Date.parse(status.expiresAt)
      : Number.NaN;
  return {
    authenticated: status.authenticated,
    provider: "codex-device",
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
  };
}

const defaultAuthService: InternalOcrAuthService = {
  getStatus: getCodexDeviceAuthStatus,
  startBrowser: startCodexBrowserAuth,
  startDevice: startDeviceCodeAuth,
  complete: completeCodexBrowserAuth,
  logout: clearCodexDeviceAuth,
};

export const internalOcrController: FastifyPluginAsync<InternalOcrControllerOptions> = async (
  app,
  options,
) => {
  const replayGuard = options.replayGuard ?? new InternalRequestReplayGuard();
  const authService = options.authService ?? defaultAuthService;
  const onPreviousKeyUsed = (nodeId: string) => {
    app.log.warn({ nodeId, boundary: "ocr" }, "internal-hmac-previous-key-used");
  };

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/ocr/line-image", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authenticated = authenticateSignedRequest({
      request,
      rawBody,
      path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      access: "read",
      options,
      onPreviousKeyUsed,
    });
    if (!authenticated) return sendInternalAuthFailed(reply);
    if (authenticated.requestId === "") return sendInternalForbidden(reply);

    let body: OcrLineImageRequest;
    try {
      body = parseLineImageRequest(rawBody);
    } catch (error) {
      return sendInvalidOcrRequest(reply, error);
    }
    if (!await consumeRequest(replayGuard, authenticated, "ocr-read", reply)) return;

    let tempDir = "";
    try {
      const imageBuffer = Buffer.from(body.imageBase64, "base64");
      tempDir = await mkdtemp(join(tmpdir(), "spx-ocr-line-image-"));
      const imagePath = join(tempDir, `line-upload${extensionForOcrMimeType(body.mimeType)}`);
      await writeFile(imagePath, imageBuffer, { flag: "wx" });

      const reader = options.readLineImage ?? defaultReadLineImage;
      const read = await reader({
        imagePath,
        mimeType: body.mimeType,
        prompt: options.prompt ?? DEFAULT_CODEX_IMAGE_PROMPT,
        timeoutMs: options.timeoutMs ?? env.CODEX_IMAGE_TIMEOUT_MS,
      });
      return sendSuccess(reply, toOcrResponse(read));
    } catch (error) {
      return retryableUnavailable(
        reply,
        error instanceof Error ? error.message : "OCR read failed",
      );
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  const registerAdminRoute = (
    route: string,
    expectedKind: OcrAdminCommand["kind"],
  ): void => {
    app.post(route.replace("/internal", ""), async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = typeof request.body === "string" ? request.body : "";
      const authenticated = authenticateSignedRequest({
        request,
        rawBody,
        path: route,
        access: "admin",
        options,
        onPreviousKeyUsed,
      });
      if (!authenticated) return sendInternalAuthFailed(reply);
      if (authenticated.requestId === "") return sendInternalForbidden(reply);

      let command: OcrAdminCommand;
      try {
        command = parseAdminCommand(rawBody, expectedKind);
      } catch (error) {
        return sendInvalidOcrRequest(reply, error);
      }
      if (!await consumeRequest(replayGuard, authenticated, "ocr-admin", reply)) return;

      try {
        if (command.kind === "status") {
          return sendSuccess(reply, publicAuthStatus(await authService.getStatus()));
        }
        if (command.kind === "start") {
          const result = command.mode === "device"
            ? await authService.startDevice()
            : await authService.startBrowser();
          return sendSuccess(reply, { ...(isObject(result) ? result : {}), mode: command.mode });
        }
        if (command.kind === "complete") {
          return sendSuccess(reply, await authService.complete(command.input));
        }
        await authService.logout();
        return sendSuccess(reply, { loggedOut: true });
      } catch {
        return retryableAdminUnavailable(reply);
      }
    });
  };

  registerAdminRoute(OCR_INTERNAL_ADMIN_STATUS_PATH, "status");
  registerAdminRoute(OCR_INTERNAL_ADMIN_START_PATH, "start");
  registerAdminRoute(OCR_INTERNAL_ADMIN_COMPLETE_PATH, "complete");
  registerAdminRoute(OCR_INTERNAL_ADMIN_LOGOUT_PATH, "logout");
};
