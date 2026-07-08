import assert from "node:assert/strict";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import {
  OCR_INTERNAL_READ_LINE_IMAGE_PATH,
  type OcrLineImageRequest,
} from "../src/services/ocr-service-contract.js";
import { readLineImageViaOcrService } from "../src/services/ocr-service-client.js";

const sharedSecret = "super-secret-value";
const nodeId = "line-service-01";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

async function testSendsSignedOcrRequest(): Promise<void> {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";
  let signalSeen = false;
  const request: OcrLineImageRequest = {
    imageBase64: Buffer.from("image-bytes").toString("base64"),
    mimeType: "image/png",
    traceId: "trace-1",
    chatId: "C123",
    senderId: "U123",
  };

  const result = await readLineImageViaOcrService(
    {
      baseUrl: "https://ocr.internal.example/",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = new Headers(init.headers);
        capturedBody = String(init.body);
        signalSeen = init.signal instanceof AbortSignal;
        return jsonResponse({
          status: "success",
          data: {
            text: "ocr text",
            attempts: 2,
            validation: { ok: true },
          },
        });
      },
    },
    request,
  );

  assert.deepEqual(result, {
    ok: true,
    text: "ocr text",
    attempts: 2,
    validation: { ok: true },
    retryable: false,
  });
  assert.equal(capturedUrl, `https://ocr.internal.example${OCR_INTERNAL_READ_LINE_IMAGE_PATH}`);
  assert.equal(capturedBody, JSON.stringify(request));
  assert.equal(capturedHeaders?.get("x-spx-node-id"), nodeId);
  assert.equal(capturedHeaders?.get("content-type"), "application/json");
  assert.equal(signalSeen, true);

  const timestamp = capturedHeaders?.get("x-spx-timestamp");
  const signature = capturedHeaders?.get("x-spx-signature");
  assert.deepEqual(
    verifyInternalSignature({
      body: capturedBody,
      timestamp: timestamp ?? "",
      nodeId,
      path: OCR_INTERNAL_READ_LINE_IMAGE_PATH,
      secret: sharedSecret,
      signature: signature ?? "",
      now: new Date(timestamp ?? ""),
    }),
    { ok: true },
  );
}

async function testRetryableAndPermanentFailures(): Promise<void> {
  const retryable = await readLineImageViaOcrService(
    {
      baseUrl: "https://ocr.internal.example",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async () => textResponse("ocr-service down", 503),
    },
    { imageBase64: "aW1hZ2U=", mimeType: "image/png", traceId: "trace-1" },
  );
  assert.deepEqual(retryable, {
    ok: false,
    error: "ocr-service down",
    retryable: true,
  });

  const permanent = await readLineImageViaOcrService(
    {
      baseUrl: "https://ocr.internal.example",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
      fetchImpl: async () => textResponse("bad signature", 401),
    },
    { imageBase64: "aW1hZ2U=", mimeType: "image/png", traceId: "trace-1" },
  );
  assert.deepEqual(permanent, {
    ok: false,
    error: "bad signature",
    retryable: false,
  });
}

async function testInvalidBaseUrlIsPermanentFailure(): Promise<void> {
  const result = await readLineImageViaOcrService(
    {
      baseUrl: "not a url",
      sharedSecret,
      nodeId,
      requestTimeoutMs: 25,
    },
    { imageBase64: "aW1hZ2U=", mimeType: "image/png", traceId: "trace-1" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
}

async function main(): Promise<void> {
  await testSendsSignedOcrRequest();
  await testRetryableAndPermanentFailures();
  await testInvalidBaseUrlIsPermanentFailure();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
