import assert from "node:assert/strict";
import {
  formatLineImageListenerError,
  isLineImageReadTimeout,
} from "../src/services/line-bot.js";

const readFailedPrefix = "\u0e2d\u0e48\u0e32\u0e19\u0e23\u0e39\u0e1b\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08";

const timeoutError = new Error("The operation was aborted due to timeout");
assert.equal(isLineImageReadTimeout(timeoutError), true);
assert.equal(
  formatLineImageListenerError(timeoutError, 300000),
  `${readFailedPrefix}: OCR timeout after 300s. Please resend/crop clearer image.`,
);

const regularError = new Error("Codex OAuth token response missing required fields");
assert.equal(isLineImageReadTimeout(regularError), false);
assert.equal(
  formatLineImageListenerError(regularError, 300000),
  `${readFailedPrefix}: Codex OAuth token response missing required fields`,
);
