import assert from "node:assert/strict";
import { parseLineImageExtraction, validateLineImageExtraction } from "../src/services/line-image-extraction.js";

const aiText = `วันที่ : 20260520
เลขทริป : LT0Q5L2657AJ2
ชื่อคนขับ : LH-PWL driver
ชื่อ Agency: LH-PWL
ประเภทรถ: 6WH
เส้นทาง : NERC-B > SOCE`;

const parsed = parseLineImageExtraction(aiText);
assert.equal(parsed.dateText, "20260520");
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
