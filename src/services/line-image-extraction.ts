import { copyFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { getLineImageExtractionByTripNumber, insertLineImageExtraction } from "../repositories/line-image-extraction-repository.js";

export const REQUIRED_LINE_IMAGE_AGENCY = "LH-PWL";

const UNCLEAR_TH = "\u0e44\u0e21\u0e48\u0e0a\u0e31\u0e14";
const STORED_IMAGE_ROOT = resolve(process.cwd(), "data", "line-images");

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

  return { ok: true, parsed: { ...complete, agencyName: REQUIRED_LINE_IMAGE_AGENCY } };
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
  const absoluteImagePath = resolve(STORED_IMAGE_ROOT, dateFolder, `${Date.now()}-${randomUUID()}.jpg`);
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
