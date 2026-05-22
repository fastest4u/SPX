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
