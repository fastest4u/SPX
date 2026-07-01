import assert from "node:assert/strict";
import {
  bufferLineImageBlob,
  formatLineImageListenerError,
  isRecoverableLineJsListenerRejection,
  isLineImageReadTimeout,
} from "../src/services/line-bot.js";

const readFailedPrefix = "\u0e2d\u0e48\u0e32\u0e19\u0e23\u0e39\u0e1b\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08";

const timeoutError = new Error("The operation was aborted due to timeout");
assert.equal(isLineImageReadTimeout(timeoutError), true);
assert.equal(
  formatLineImageListenerError(timeoutError, 300000),
  `${readFailedPrefix}: OCR timeout after 300s. Please resend/crop clearer image.`,
);

async function main(): Promise<void> {
  const regularError = new Error("Codex OAuth token response missing required fields");
  assert.equal(isLineImageReadTimeout(regularError), false);
  assert.equal(
    formatLineImageListenerError(regularError, 300000),
    `${readFailedPrefix}: OCR failed. Please try again.`,
  );

  const pngBlob = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
  const png = await bufferLineImageBlob(pngBlob, 1024);
  assert.equal(png.mimeType, "image/png");

  await assert.rejects(
    () => bufferLineImageBlob(new Blob([Buffer.alloc(5)], { type: "image/jpeg" }), 4),
    /too large/i,
  );
  await assert.rejects(
    () => bufferLineImageBlob(new Blob([Buffer.from("not an image")], { type: "text/plain" }), 1024),
    /unsupported/i,
  );
  await assert.rejects(
    () => bufferLineImageBlob(new Blob([Buffer.from("not an image")], { type: "image/jpeg" }), 1024),
    /unsupported/i,
  );

  const secretError = new Error("Provider failed: Bearer sk-test-secret code=abc123 refresh_token=rt");
  assert.equal(
    formatLineImageListenerError(secretError, 300000),
    `${readFailedPrefix}: OCR failed. Please try again.`,
  );

  const lineJsFetchError = new TypeError("fetch failed");
  lineJsFetchError.stack = [
    "TypeError: fetch failed",
    "    at BaseClient.fetch (file:///app/node_modules/@evex/linejs/base/core/mod.js:110:17)",
    "    at Polling.initLegyPusher (file:///app/node_modules/@evex/linejs/base/polling/mod.js:98:15)",
  ].join("\n");
  assert.equal(isRecoverableLineJsListenerRejection(lineJsFetchError), true);

  const appFetchError = new TypeError("fetch failed");
  appFetchError.stack = [
    "TypeError: fetch failed",
    "    at currentTeamController (file:///app/dist/controllers/teams-controller.js:130:15)",
  ].join("\n");
  assert.equal(isRecoverableLineJsListenerRejection(appFetchError), false);

  console.log("line-image-listener: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
