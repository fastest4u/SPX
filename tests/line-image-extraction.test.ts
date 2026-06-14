import assert from "node:assert/strict";
import {
  LINE_IMAGE_EXAMPLE_OUTPUT,
  buildLineImageRetryPrompt,
  parseLineImageExtraction,
  readLineImageWithRetry,
  shouldRetryLineImageValidation,
  storedLineImageExtensionForPath,
  validateLineImageExtraction,
} from "../src/services/line-image-extraction.js";
import { DEFAULT_CODEX_IMAGE_PROMPT } from "../src/services/codex-image-reader.js";

const aiText = `วันที่ : 20 May 2026
เลขทริป : LT0Q5L2657AJ2
ชื่อคนขับ : LH-PWL driver
ชื่อ Agency: LH-PWL
ประเภทรถ: 6WH
เส้นทาง : NERC-B > SOCE`;

const parsed = parseLineImageExtraction(aiText);
assert.equal(parsed.dateText, "20 May 2026");
assert.equal(parsed.tripNumber, "LT0Q5L2657AJ2");
assert.equal(parsed.driverName, "LH-PWL driver");
assert.equal(parsed.agencyName, "LH-PWL");
assert.equal(parsed.vehicleType, "6WH");
assert.equal(parsed.route, "NERC-B > SOCE");

const validation = validateLineImageExtraction(aiText);
assert.equal(validation.ok, true);
if (validation.ok) {
  assert.equal(validation.parsed.tripNumber, "LT0Q5L2657AJ2");
}

const textWithEmbeddedTripDateAndStd = `วันที่ : 31 May 2026
เลขทริป : LT0Q6526IXSH1
ชื่อคนขับ : LH LH-PWL 7005778 6WH7.2 พิษณุพงศ์ วงศ์วิหา - SUB
ชื่อ Agency: LH-PWL
ประเภทรถ: 6WH-6ล้อ[7.2m]
เส้นทาง : NORC-B > SOCN
ชื่อทริป : 20260605(รถเสริม) NORC-B > SOCN - 31May2026 Slot2
STA: 2026/06/06 09:00:00
STD: 2026/06/05 21:00:00`;

const parsedWithStd = parseLineImageExtraction(textWithEmbeddedTripDateAndStd);
assert.equal(parsedWithStd.dateText, "05 Jun 2026");
assert.equal(parsedWithStd.tripNumber, "LT0Q6526IXSH1");

const validationWithStd = validateLineImageExtraction(textWithEmbeddedTripDateAndStd);
assert.equal(validationWithStd.ok, true);
if (validationWithStd.ok) {
  assert.equal(validationWithStd.parsed.dateText, "05 Jun 2026");
}

const textWithUnclearStd = `วันที่ : 31 May 2026
เลขทริป : LT0Q6526IXSH1
ชื่อคนขับ : LH LH-PWL 7005778 6WH7.2 พิษณุพงศ์ วงศ์วิหา - SUB
ชื่อ Agency: LH-PWL
ประเภทรถ: 6WH-6ล้อ[7.2m]
เส้นทาง : NORC-B > SOCN
ชื่อทริป : 20260605(รถเสริม) NORC-B > SOCN - 31May2026 Slot2
STD: ไม่ชัด`;

const parsedWithUnclearStd = parseLineImageExtraction(textWithUnclearStd);
assert.equal(parsedWithUnclearStd.dateText, "ไม่ชัด");

const validationWithUnclearStd = validateLineImageExtraction(textWithUnclearStd);
assert.equal(validationWithUnclearStd.ok, false);
if (!validationWithUnclearStd.ok) {
  assert.match(validationWithUnclearStd.reason, /dateText/);
}

// ── Format validation: compact/legacy date is no longer accepted ──
const textWithCompactDate = aiText.replace("วันที่ : 20 May 2026", "วันที่ : 20260520");
const compactDateValidation = validateLineImageExtraction(textWithCompactDate);
assert.equal(compactDateValidation.ok, false);
if (!compactDateValidation.ok) {
  assert.match(compactDateValidation.reason, /^invalid_format:/);
  assert.match(compactDateValidation.reason, /dateText/);
}

// Impossible calendar date is rejected even when the shape looks right
const textWithImpossibleDate = aiText.replace("20 May 2026", "32 May 2026");
const impossibleDateValidation = validateLineImageExtraction(textWithImpossibleDate);
assert.equal(impossibleDateValidation.ok, false);
if (!impossibleDateValidation.ok) {
  assert.match(impossibleDateValidation.reason, /dateText/);
}

// Trip number must start with LT followed by A-Z/0-9 only
const textWithBadTrip = aiText.replace("LT0Q5L2657AJ2", "0Q5L2657AJ2");
const badTripValidation = validateLineImageExtraction(textWithBadTrip);
assert.equal(badTripValidation.ok, false);
if (!badTripValidation.ok) {
  assert.match(badTripValidation.reason, /^invalid_format:/);
  assert.match(badTripValidation.reason, /tripNumber/);
}

// Lowercase trip numbers are normalized to uppercase instead of rejected
const textWithLowercaseTrip = aiText.replace("LT0Q5L2657AJ2", "lt0q5l2657aj2");
const lowercaseTripValidation = validateLineImageExtraction(textWithLowercaseTrip);
assert.equal(lowercaseTripValidation.ok, true);
if (lowercaseTripValidation.ok) {
  assert.equal(lowercaseTripValidation.parsed.tripNumber, "LT0Q5L2657AJ2");
}

// Route must contain at least one "A > B" hop
const textWithBadRoute = aiText.replace("NERC-B > SOCE", "NERC-B SOCE");
const badRouteValidation = validateLineImageExtraction(textWithBadRoute);
assert.equal(badRouteValidation.ok, false);
if (!badRouteValidation.ok) {
  assert.match(badRouteValidation.reason, /^invalid_format:/);
  assert.match(badRouteValidation.reason, /route/);
}

// Multi-hop routes stay valid
const textWithMultiHopRoute = aiText.replace("NERC-B > SOCE", "NERC-B > SOCE > SOCN");
assert.equal(validateLineImageExtraction(textWithMultiHopRoute).ok, true);

// All invalid fields are reported together
const textWithTwoBadFields = aiText
  .replace("20 May 2026", "20260520")
  .replace("NERC-B > SOCE", "NERC-B SOCE");
const twoBadValidation = validateLineImageExtraction(textWithTwoBadFields);
assert.equal(twoBadValidation.ok, false);
if (!twoBadValidation.ok) {
  assert.match(twoBadValidation.reason, /dateText/);
  assert.match(twoBadValidation.reason, /route/);
}

// ── The canonical example shipped inside the prompt must itself validate ──
assert.equal(validateLineImageExtraction(LINE_IMAGE_EXAMPLE_OUTPUT).ok, true);
assert.equal(DEFAULT_CODEX_IMAGE_PROMPT.includes(LINE_IMAGE_EXAMPLE_OUTPUT), true);
assert.equal(storedLineImageExtensionForPath("upload.png"), ".png");
assert.equal(storedLineImageExtensionForPath("upload.webp"), ".webp");
assert.equal(storedLineImageExtensionForPath("upload.jpeg"), ".jpg");
assert.equal(storedLineImageExtensionForPath("upload"), ".jpg");

// ── Retry gating: format/unclear failures retry, business rejections do not ──
assert.equal(shouldRetryLineImageValidation(validateLineImageExtraction(textWithBadTrip)), true);
assert.equal(shouldRetryLineImageValidation(validateLineImageExtraction(textWithUnclearStd)), true);

const textWithForeignAgency = aiText.replace("ชื่อ Agency: LH-PWL", "ชื่อ Agency: LH-OTHER");
const foreignAgencyValidation = validateLineImageExtraction(textWithForeignAgency);
assert.equal(foreignAgencyValidation.ok, false);
if (!foreignAgencyValidation.ok) {
  assert.match(foreignAgencyValidation.reason, /^agency_not_allowed:/);
}
assert.equal(shouldRetryLineImageValidation(foreignAgencyValidation), false);
assert.equal(shouldRetryLineImageValidation(validation), false);

// ── Retry prompt carries the base prompt, failed fields, and previous answer ──
if (!badTripValidation.ok) {
  const retryPrompt = buildLineImageRetryPrompt("BASE-PROMPT", badTripValidation, "PREVIOUS-ANSWER");
  assert.equal(retryPrompt.includes("BASE-PROMPT"), true);
  assert.equal(retryPrompt.includes("เลขทริป"), true);
  assert.equal(retryPrompt.includes("PREVIOUS-ANSWER"), true);
}

(async () => {
  // ── readLineImageWithRetry: success on first attempt does not re-read ──
  {
    const prompts: Array<string | undefined> = [];
    const result = await readLineImageWithRetry(async (promptOverride) => {
      prompts.push(promptOverride);
      return aiText;
    }, "BASE-PROMPT");
    assert.equal(result.attempts, 1);
    assert.equal(result.validation.ok, true);
    assert.deepEqual(prompts, [undefined]);
  }

  // ── readLineImageWithRetry: invalid first read triggers exactly one retry ──
  {
    const prompts: Array<string | undefined> = [];
    const result = await readLineImageWithRetry(async (promptOverride) => {
      prompts.push(promptOverride);
      return prompts.length === 1 ? textWithBadTrip : aiText;
    }, "BASE-PROMPT");
    assert.equal(result.attempts, 2);
    assert.equal(result.validation.ok, true);
    assert.equal(result.text, aiText);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], undefined);
    assert.equal(prompts[1]?.includes("BASE-PROMPT"), true);
    assert.equal(prompts[1]?.includes("เลขทริป"), true);
  }

  // ── readLineImageWithRetry: still invalid after retry returns the second result ──
  {
    const prompts: Array<string | undefined> = [];
    const result = await readLineImageWithRetry(async (promptOverride) => {
      prompts.push(promptOverride);
      return textWithBadTrip;
    }, "BASE-PROMPT");
    assert.equal(result.attempts, 2);
    assert.equal(result.validation.ok, false);
    assert.equal(prompts.length, 2);
  }

  // ── readLineImageWithRetry: business rejection (agency) is not retried ──
  {
    const prompts: Array<string | undefined> = [];
    const result = await readLineImageWithRetry(async (promptOverride) => {
      prompts.push(promptOverride);
      return textWithForeignAgency;
    }, "BASE-PROMPT");
    assert.equal(result.attempts, 1);
    assert.equal(result.validation.ok, false);
    assert.equal(prompts.length, 1);
  }

  console.log("line-image-extraction tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
