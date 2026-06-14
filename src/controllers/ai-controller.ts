import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
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

export const aiController: FastifyPluginAsync = async (app) => {
  app.get("/codex-auth/status", async (_req, reply) => {
    return sendSuccess(reply, await getCodexDeviceAuthStatus());
  });

  app.post<{ Body: StartCodexAuthBody }>(
    "/codex-auth/start",
    { schema: { body: startCodexAuthSchema } },
    async (req, reply) => {
      try {
        const mode = req.body?.mode;
        if (!mode) {
          return sendError(reply, 400, "CODEX_AUTH_MODE_REQUIRED", "Choose a Codex auth mode: browser or device.");
        }

        const result = mode === "device"
          ? await startDeviceCodeAuth()
          : await startCodexBrowserAuth();
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
      const input = req.body.callbackUrl || req.body.code || "";
      if (!input.trim()) {
        return sendError(reply, 400, "CODEX_AUTH_INPUT_REQUIRED", "callbackUrl or code is required.");
      }
      try {
        return sendSuccess(reply, await completeCodexBrowserAuth(input), "Codex OAuth login completed");
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

  app.post("/codex-auth/logout", async (_req, reply) => {
    await clearCodexDeviceAuth();
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
