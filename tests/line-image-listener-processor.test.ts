import assert from "node:assert/strict";
import {
  processLineImage,
  type ProcessLineImageOptions,
} from "../src/services/line-image-processor.js";
import { LINE_IMAGE_EXAMPLE_OUTPUT } from "../src/services/line-image-extraction.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function baseOptions(): ProcessLineImageOptions {
  return {
    tempImagePath: "line-upload.png",
    imageBuffer: pngBytes,
    mimeType: "image/png",
    chatId: "C123",
    senderId: "U123",
    traceId: "trace-1",
    timeoutMs: 300000,
    prompt: "read the image",
    ocrServiceUrl: "",
    sharedSecret: "secret",
    nodeId: "line-service-01",
    ocrServiceRequestTimeoutMs: 5000,
    persistExtraction: async ({ aiText }) => ({
      saved: aiText === LINE_IMAGE_EXAMPLE_OUTPUT,
      id: aiText === LINE_IMAGE_EXAMPLE_OUTPUT ? 77 : null,
      reason: aiText === LINE_IMAGE_EXAMPLE_OUTPUT ? undefined : "invalid",
    }),
  };
}

async function testRemoteOcrUsedWhenConfigured(): Promise<void> {
  const remoteCalls: unknown[] = [];
  const localCalls: unknown[] = [];

  const result = await processLineImage({
    ...baseOptions(),
    ocrServiceUrl: "https://ocr.internal.example",
    readRemoteLineImage: async (_options, request) => {
      remoteCalls.push(request);
      return {
        ok: true,
        text: LINE_IMAGE_EXAMPLE_OUTPUT,
        attempts: 1,
        validation: { ok: true },
        retryable: false,
      };
    },
    readLocalLineImage: async () => {
      localCalls.push("local");
      throw new Error("local should not run");
    },
  });

  assert.equal(result.usedRemoteOcr, true);
  assert.equal(result.replyText, `${LINE_IMAGE_EXAMPLE_OUTPUT}\n\nSaved to DB: #77`);
  assert.deepEqual(localCalls, []);
  assert.deepEqual(remoteCalls, [
    {
      imageBase64: pngBytes.toString("base64"),
      mimeType: "image/png",
      traceId: "trace-1",
      chatId: "C123",
      senderId: "U123",
    },
  ]);
}

async function testLocalOcrUsedWithoutRemoteUrl(): Promise<void> {
  let localReadCount = 0;
  const result = await processLineImage({
    ...baseOptions(),
    readLocalLineImage: async () => {
      localReadCount += 1;
      return {
        text: LINE_IMAGE_EXAMPLE_OUTPUT,
        attempts: 1,
        validation: { ok: true, parsed: {} as never },
      };
    },
  });

  assert.equal(result.usedRemoteOcr, false);
  assert.equal(localReadCount, 1);
  assert.equal(result.replyText, `${LINE_IMAGE_EXAMPLE_OUTPUT}\n\nSaved to DB: #77`);
}

async function testRemoteFailureThrowsForListenerReplyPath(): Promise<void> {
  await assert.rejects(
    () =>
      processLineImage({
        ...baseOptions(),
        ocrServiceUrl: "https://ocr.internal.example",
        readRemoteLineImage: async () => ({
          ok: false,
          error: "ocr-service down",
          retryable: true,
        }),
      }),
    /ocr-service down/,
  );
}

async function main(): Promise<void> {
  await testRemoteOcrUsedWhenConfigured();
  await testLocalOcrUsedWithoutRemoteUrl();
  await testRemoteFailureThrowsForListenerReplyPath();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
