import { copyFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, relative, resolve } from "node:path";
import { getLineImageExtractionByTripNumber, insertLineImageExtraction } from "../repositories/line-image-extraction-repository.js";

export const REQUIRED_LINE_IMAGE_AGENCY = "LH-PWL";

/**
 * Canonical example of a valid model reply. Embedded into the OCR prompt as a
 * few-shot anchor and asserted by tests so prompt format and parser/validator
 * can never drift apart.
 */
export const LINE_IMAGE_EXAMPLE_OUTPUT = `\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48 : 05 Jun 2026
\u0e40\u0e25\u0e02\u0e17\u0e23\u0e34\u0e1b : LT0Q6526IXSH1
\u0e0a\u0e37\u0e48\u0e2d\u0e04\u0e19\u0e02\u0e31\u0e1a : LH LH-PWL 7005778 6WH7.2 \u0e2a\u0e21\u0e0a\u0e32\u0e22 \u0e43\u0e08\u0e14\u0e35 - SUB
\u0e0a\u0e37\u0e48\u0e2d Agency: LH-PWL
\u0e1b\u0e23\u0e30\u0e40\u0e20\u0e17\u0e23\u0e16: 6WH-6\u0e25\u0e49\u0e2d[7.2m]
\u0e40\u0e2a\u0e49\u0e19\u0e17\u0e32\u0e07 : NORC-B > SOCN`;

const UNCLEAR_TH = "\u0e44\u0e21\u0e48\u0e0a\u0e31\u0e14";
const STORED_IMAGE_ROOT = resolve(process.cwd(), "data", "line-images");

export function storedLineImageExtensionForPath(imagePath: string): ".jpg" | ".png" | ".webp" {
  const extension = extname(imagePath).toLowerCase();
  if (extension === ".png") return ".png";
  if (extension === ".webp") return ".webp";
  return ".jpg";
}

export interface ParsedLineImageExtraction {
  dateText: string;
  tripNumber: string;
  driverName: string;
  agencyName: string;
  vehicleType: string;
  route: string;
}

export type LineImageExtractionValidation =
  | { ok: true; parsed: ParsedLineImageExtraction }
  | { ok: false; reason: string; parsed: Partial<ParsedLineImageExtraction> };

const LINE_IMAGE_FIELD_LABELS: Array<{ field: keyof ParsedLineImageExtraction; pattern: RegExp }> = [
  { field: "dateText", pattern: /^(?:วันที่|date)\b/i },
  { field: "tripNumber", pattern: /^(?:เลขทริป|trip(?:\s*(?:no\.?|number))?)\b/i },
  { field: "driverName", pattern: /^(?:ชื่อคนขับ|driver(?:\s*name)?)\b/i },
  { field: "agencyName", pattern: /^(?:ชื่อ\s*agency|agency(?:\s*name)?)\b/i },
  { field: "vehicleType", pattern: /^(?:ประเภทรถ|vehicle(?:\s*type)?)\b/i },
  { field: "route", pattern: /^(?:เส้นทาง|route)\b/i },
];

const POSITIONAL_FIELD_ORDER: Array<keyof ParsedLineImageExtraction> = [
  "dateText",
  "tripNumber",
  "driverName",
  "agencyName",
  "vehicleType",
  "route",
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Per-field format contracts. A value that parses but violates its contract is a
// likely misread; reporting it as invalid_format (instead of saving silently)
// lets the read be retried with targeted feedback.
const TRIP_NUMBER_PATTERN = /^LT[0-9A-Z]{6,}$/;
const DATE_TEXT_PATTERN = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/;
const ROUTE_PATTERN = /^[A-Z0-9][A-Z0-9-]*(?:\s*(?:>|->|→)\s*[A-Z0-9][A-Z0-9-]*)+$/i;

function isValidDateText(value: string): boolean {
  const match = value.match(DATE_TEXT_PATTERN);
  if (!match) {
    return false;
  }
  const day = Number(match[1]);
  const month = MONTH_NAMES.indexOf(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day;
}

function formatStdDateValue(value: string): string | null {
  const match = value.match(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(day).padStart(2, "0")} ${MONTH_NAMES[month - 1]} ${year}`;
}

function extractStdDateText(lines: string[]): string | undefined {
  for (const line of lines) {
    const separatorIndex = line.search(/[:：]/);
    if (separatorIndex < 0) {
      continue;
    }

    const labelPart = line.slice(0, separatorIndex).trim();
    if (!/^STD$/i.test(labelPart)) {
      continue;
    }

    const valuePart = line.slice(separatorIndex + 1).trim();
    return formatStdDateValue(valuePart) ?? UNCLEAR_TH;
  }

  return undefined;
}

export function parseLineImageExtraction(text: string): Partial<ParsedLineImageExtraction> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Pass 1: label-based — detect a "label: value" form for each field and build a keyed map.
  const labelled: Partial<Record<keyof ParsedLineImageExtraction, string>> = {};
  for (const line of lines) {
    const separatorIndex = line.search(/[:：]/);
    if (separatorIndex < 0) {
      continue;
    }
    const labelPart = line.slice(0, separatorIndex).trim();
    const valuePart = line.slice(separatorIndex + 1).trim();
    const match = LINE_IMAGE_FIELD_LABELS.find(({ pattern }) => pattern.test(labelPart));
    if (match && labelled[match.field] === undefined) {
      labelled[match.field] = valuePart;
    }
  }

  // Pass 2: positional fallback — strip any "label:" prefix and read by index.
  const positional = lines
    .slice(0, 6)
    .map((line) => {
      const separatorIndex = line.search(/[:：]/);
      return (separatorIndex >= 0 ? line.slice(separatorIndex + 1) : line).trim();
    });

  const result: Partial<ParsedLineImageExtraction> = {};
  POSITIONAL_FIELD_ORDER.forEach((field, index) => {
    const labelledValue = labelled[field];
    result[field] = labelledValue !== undefined ? labelledValue : positional[index] ?? "";
  });

  const stdDateText = extractStdDateText(lines);
  if (stdDateText !== undefined) {
    result.dateText = stdDateText;
  }

  return result;
}

export function normalizeAgencyName(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "").replace(/\s*-\s*/g, "-");
}

function isCompleteValue(value: string | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && !trimmed.includes(UNCLEAR_TH);
}

export function validateLineImageExtraction(text: string): LineImageExtractionValidation {
  const parsed = parseLineImageExtraction(text);
  const missing = Object.entries(parsed)
    .filter(([, value]) => !isCompleteValue(value))
    .map(([key]) => key);

  if (missing.length > 0) {
    return { ok: false, reason: `missing_or_unclear:${missing.join(",")}`, parsed };
  }

  const complete = parsed as ParsedLineImageExtraction;
  if (normalizeAgencyName(complete.agencyName) !== REQUIRED_LINE_IMAGE_AGENCY) {
    return { ok: false, reason: `agency_not_allowed:${complete.agencyName}`, parsed };
  }

  const normalizedTripNumber = complete.tripNumber.trim().toUpperCase();
  const invalidFields: string[] = [];
  if (!TRIP_NUMBER_PATTERN.test(normalizedTripNumber)) {
    invalidFields.push("tripNumber");
  }
  if (!isValidDateText(complete.dateText.trim())) {
    invalidFields.push("dateText");
  }
  if (!ROUTE_PATTERN.test(complete.route.trim())) {
    invalidFields.push("route");
  }
  if (invalidFields.length > 0) {
    return { ok: false, reason: `invalid_format:${invalidFields.join(",")}`, parsed };
  }

  return {
    ok: true,
    parsed: { ...complete, agencyName: REQUIRED_LINE_IMAGE_AGENCY, tripNumber: normalizedTripNumber },
  };
}

// ── Read-with-retry orchestration ─────────────────────────────────────────────

export interface LineImageReadResult {
  text: string;
  validation: LineImageExtractionValidation;
  attempts: number;
}

const LINE_IMAGE_FIELD_FEEDBACK: Record<string, string> = {
  dateText: "วันที่ (ต้องเป็นรูปแบบ DD Mon YYYY เช่น 05 Jun 2026 และมาจากแถว STD เท่านั้น)",
  tripNumber: "เลขทริป (ต้องขึ้นต้นด้วย LT ตามด้วยตัวอักษรอังกฤษ/ตัวเลขเท่านั้น ห้ามมีช่องว่าง)",
  driverName: "ชื่อคนขับ (คัดลอกค่าทั้งหมดหลัง \"ชื่อคนขับ:\")",
  agencyName: "ชื่อ Agency",
  vehicleType: "ประเภทรถ",
  route: "เส้นทาง (รูปแบบ รหัสต้นทาง > รหัสปลายทาง เช่น NERC-B > SOCE)",
};

function fieldsFromValidationReason(reason: string): string[] {
  return (reason.split(":")[1] ?? "").split(",").filter(Boolean);
}

/**
 * Only read-quality failures are worth a second model pass. A disallowed agency
 * is a business rejection (the runsheet genuinely belongs to another agency), so
 * re-reading would just double cost for the same outcome.
 */
export function shouldRetryLineImageValidation(validation: LineImageExtractionValidation): boolean {
  if (validation.ok) {
    return false;
  }
  return validation.reason.startsWith("missing_or_unclear:") || validation.reason.startsWith("invalid_format:");
}

export function buildLineImageRetryPrompt(
  basePrompt: string,
  validation: LineImageExtractionValidation,
  previousText: string,
): string {
  const failedFields = validation.ok ? [] : fieldsFromValidationReason(validation.reason);
  const feedbackLines = failedFields
    .map((field) => `- ${LINE_IMAGE_FIELD_FEEDBACK[field] ?? field}`)
    .join("\n");

  return `${basePrompt}

คำตอบก่อนหน้านี้ใช้ไม่ได้:
${previousText}

ช่องที่ยังผิดรูปแบบหรืออ่านไม่ครบ:
${feedbackLines}

อ่านรูปใหม่อย่างละเอียดอีกครั้ง โดยเฉพาะช่องที่ระบุด้านบน แล้วตอบใหม่ครบทั้ง 6 บรรทัดตามรูปแบบเดิมเท่านั้น ห้ามเดาค่าและห้ามคัดลอกจากคำตอบก่อนหน้าโดยไม่ตรวจกับรูป`;
}

/**
 * Run the OCR read once and, when the result fails validation for a retryable
 * reason, re-read exactly once with field-targeted feedback appended to the
 * base prompt. The second result is final either way — persistence re-validates.
 */
export async function readLineImageWithRetry(
  readOnce: (promptOverride?: string) => Promise<string>,
  basePrompt: string,
): Promise<LineImageReadResult> {
  const firstText = await readOnce(undefined);
  const firstValidation = validateLineImageExtraction(firstText);
  if (firstValidation.ok || !shouldRetryLineImageValidation(firstValidation)) {
    return { text: firstText, validation: firstValidation, attempts: 1 };
  }

  const retryPrompt = buildLineImageRetryPrompt(basePrompt, firstValidation, firstText);
  const secondText = await readOnce(retryPrompt);
  return { text: secondText, validation: validateLineImageExtraction(secondText), attempts: 2 };
}

export async function persistValidLineImageExtraction(input: {
  tempImagePath: string;
  chatId: string;
  senderId: string;
  aiText: string;
}): Promise<{ saved: boolean; id: number | null; imagePath?: string; reason?: string }> {
  const validation = validateLineImageExtraction(input.aiText);
  if (!validation.ok) {
    return { saved: false, id: null, reason: validation.reason };
  }

  // Check for duplicate trip number
  if (validation.parsed.tripNumber) {
    const existing = await getLineImageExtractionByTripNumber(validation.parsed.tripNumber);
    if (existing) {
      return { saved: false, id: null, reason: `duplicate_trip_number:${validation.parsed.tripNumber}` };
    }
  }

  const now = new Date();
  const dateFolder = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const absoluteImagePath = resolve(STORED_IMAGE_ROOT, dateFolder, `${Date.now()}-${randomUUID()}${storedLineImageExtensionForPath(input.tempImagePath)}`);
  await mkdir(dirname(absoluteImagePath), { recursive: true });
  await copyFile(input.tempImagePath, absoluteImagePath);

  const relativeImagePath = relative(process.cwd(), absoluteImagePath).replace(/\\/g, "/");
  const id = await insertLineImageExtraction({
    chatId: input.chatId,
    senderId: input.senderId,
    imagePath: relativeImagePath,
    dateText: validation.parsed.dateText,
    tripNumber: validation.parsed.tripNumber,
    driverName: validation.parsed.driverName,
    agencyName: validation.parsed.agencyName,
    vehicleType: validation.parsed.vehicleType,
    route: validation.parsed.route,
    rawText: input.aiText,
  });

  if (id === null) {
    await unlink(absoluteImagePath).catch(() => undefined);
    return { saved: false, id: null, reason: "db_insert_failed" };
  }

  return { saved: true, id, imagePath: relativeImagePath };
}
