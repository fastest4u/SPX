import assert from "node:assert/strict";
import {
  INITIAL_SETTINGS_FORM,
  validateNumericFields,
} from "../src/frontend/lib/settings-shared.js";

const cooldownDisabled = validateNumericFields({
  ...INITIAL_SETTINGS_FORM,
  BOOKING_REPROCESS_COOLDOWN_MS: "0",
});

assert.deepEqual(cooldownDisabled.errors, {});
assert.equal(cooldownDisabled.sanitized.BOOKING_REPROCESS_COOLDOWN_MS, "0");

const invalidConcurrency = validateNumericFields({
  ...INITIAL_SETTINGS_FORM,
  BOOKING_DETAIL_CONCURRENCY: "0",
});

assert.equal(
  invalidConcurrency.errors.BOOKING_DETAIL_CONCURRENCY,
  "ต้องเป็นจำนวนเต็มบวก",
);
