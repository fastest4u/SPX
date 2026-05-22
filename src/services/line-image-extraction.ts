import { copyFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { insertLineImageExtraction } from "../repositories/line-image-extraction-repository.js";

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

export function parseLineImageExtraction(text: string): Partial<ParsedLineImageExtraction> {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => {
      const separatorIndex = line.search(/[:：]/);
      return (separatorIndex >= 0 ? line.slice(separatorIndex + 1) : line).trim();
    });

  return {
    dateText: values[0] ?? "",
    tripNumber: values[1] ?? "",
    driverName: values[2] ?? "",
    agencyName: values[3] ?? "",
    vehicleType: values[4] ?? "",
    route: values[5] ?? "",
  };
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
