import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_IMAGE_PROMPT, readImageWithCodex } from "../services/codex-image-reader.js";
import { verifyInternalSignature } from "../services/internal-auth.js";
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
import { env } from "../config/env.js";
import { sendError, sendSuccess } from "../utils/response.js";

export interface InternalOcrReadInput {
  imagePath: string;
  mimeType: OcrLineImageMimeType;
  prompt: string;
  timeoutMs: number;
}

export interface InternalOcrControllerOptions {
  sharedSecret: string;
  prompt?: string;
  timeoutMs?: number;
  readLineImage?: (input: InternalOcrReadInput) => Promise<LineImageReadResult>;
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
  sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed");
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

function verifySignedRequest(input: {
  request: FastifyRequest;
  rawBody: string;
  path: string;
  sharedSecret: string;
}): { ok: true } | { ok: false } {
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
  return authResult.ok ? { ok: true } : { ok: false };
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

export const internalOcrController: FastifyPluginAsync<InternalOcrControllerOptions> = async (
  app,
  options,
) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/ocr/line-image", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const authResult = verifySignedRequest({
      request,
      rawBody,
      path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      sharedSecret: options.sharedSecret,
    });
    if (!authResult.ok) return sendInternalAuthFailed(reply);

    let body: OcrLineImageRequest;
    try {
      body = parseLineImageRequest(rawBody);
    } catch (error) {
      return sendInvalidOcrRequest(reply, error);
    }

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
};
