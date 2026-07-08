import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import {
  internalOcrController,
  type InternalOcrControllerOptions,
} from "../src/controllers/internal-ocr-controller.js";
import { createInternalSignature } from "../src/services/internal-auth.js";
import {
  OCR_INTERNAL_READ_LINE_IMAGE_PATH,
  type OcrLineImageRequest,
} from "../src/services/ocr-service-contract.js";
import { LINE_IMAGE_EXAMPLE_OUTPUT } from "../src/services/line-image-extraction.js";

const sharedSecret = "super-secret-value";
const nodeId = "line-service-01";
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function signedHeaders(input: {
  path: string;
  body: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    "content-type": "application/json",
    "x-spx-node-id": nodeId,
    "x-spx-timestamp": timestamp,
    "x-spx-signature": createInternalSignature({
      body: input.body,
      timestamp,
      nodeId,
      path: input.path,
      secret: sharedSecret,
    }),
  };
}

async function withController<T>(
  options: Omit<InternalOcrControllerOptions, "sharedSecret">,
  fn: (app: ReturnType<typeof Fastify>) => Promise<T>,
): Promise<T> {
  const app = Fastify({ logger: false });
  await app.register(internalOcrController, {
    prefix: "/internal",
    sharedSecret,
    ...options,
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function testSignedReadSucceeds(): Promise<void> {
  const calls: Array<{ imagePath: string; mimeType: string; timeoutMs: number }> = [];
  const request: OcrLineImageRequest = {
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "trace-1",
    chatId: "C123",
    senderId: "U123",
  };
  const rawBody = JSON.stringify(request);

  await withController(
    {
      timeoutMs: 1234,
      prompt: "test prompt",
      readLineImage: async ({ imagePath, mimeType, timeoutMs }) => {
        calls.push({ imagePath, mimeType, timeoutMs });
        assert.deepEqual(await readFile(imagePath), pngBytes);
        return {
          text: LINE_IMAGE_EXAMPLE_OUTPUT,
          attempts: 1,
          validation: { ok: true, parsed: {} as never },
        };
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
        payload: rawBody,
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), {
        status: "success",
        data: {
          text: LINE_IMAGE_EXAMPLE_OUTPUT,
          attempts: 1,
          validation: { ok: true },
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.mimeType, "image/png");
      assert.equal(calls[0]?.timeoutMs, 1234);
    },
  );
}

async function testAuthFailureReturns401(): Promise<void> {
  await withController(
    {
      readLineImage: async () => {
        throw new Error("should not be called");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: JSON.stringify({ imageBase64: "aW1hZ2U=", mimeType: "image/png", traceId: "t" }),
        headers: { "content-type": "application/json" },
      });

      assert.equal(response.statusCode, 401);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_AUTH_FAILED");
    },
  );
}

async function testInvalidPayloadReturns400(): Promise<void> {
  const rawBody = JSON.stringify({ imageBase64: "not-base64", mimeType: "image/gif", traceId: "" });
  await withController(
    {
      readLineImage: async () => {
        throw new Error("should not be called");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body) as { error_code: string };
      assert.equal(body.error_code, "INTERNAL_OCR_INVALID");
    },
  );
}

async function testReadFailureReturnsRetryable503(): Promise<void> {
  const rawBody = JSON.stringify({
    imageBase64: pngBytes.toString("base64"),
    mimeType: "image/png",
    traceId: "trace-1",
  });
  await withController(
    {
      readLineImage: async () => {
        throw new Error("codex unavailable");
      },
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
        payload: rawBody,
        headers: signedHeaders({ path: OCR_INTERNAL_READ_LINE_IMAGE_PATH, body: rawBody }),
      });

      assert.equal(response.statusCode, 503);
      const body = JSON.parse(response.body) as {
        error_code: string;
        details?: { retryable?: boolean };
      };
      assert.equal(body.error_code, "OCR_READ_FAILED");
      assert.equal(body.details?.retryable, true);
      assert.equal(response.body.includes("C123"), false);
    },
  );
}

async function main(): Promise<void> {
  await testSignedReadSucceeds();
  await testAuthFailureReturns401();
  await testInvalidPayloadReturns400();
  await testReadFailureReturnsRetryable503();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
