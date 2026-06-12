import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { codexExec, type CodexExecSettings } from "ai-sdk-provider-codex-cli";
import { env } from "../config/env.js";
import { codexDeviceModel, hasCodexDeviceAuth } from "./codex-device-auth.js";
import { LINE_IMAGE_EXAMPLE_OUTPUT } from "./line-image-extraction.js";

export const DEFAULT_CODEX_IMAGE_PROMPT = `อ่านข้อมูลจากรูปเอกสาร SPX Linehaul Trip Runsheet แล้วตอบกลับเฉพาะ 6 บรรทัดนี้เท่านั้น ห้ามสรุป ห้ามตัดคำ ห้ามแสดงข้อความอื่น:
วันที่ : <วันที่จากแถว STD เท่านั้น เช่น STD: 2026/06/05 21:00:00 ให้ตอบ 05 Jun 2026>
เลขทริป : <เลขทริปในรูป เช่น LT0Q5L2657AJ2>
ชื่อคนขับ : <คัดลอกค่าทั้งหมดหลัง "ชื่อคนขับ:" รวมรหัส agency เลขทะเบียน ประเภทรถ ชื่อคน และ - SUB ถ้ามี>
ชื่อ Agency: <ชื่อ Agency ในรูป>
ประเภทรถ: <ประเภทรถในรูป>
เส้นทาง : <เส้นทางในรูป เช่น NERC-B > SOCE>

กติกาวันที่: ใช้เฉพาะแถวที่ขึ้นต้นว่า STD เท่านั้น ห้ามใช้วันที่ในชื่อทริป, Slot, STA, เวลา Seal, หรือวันที่อื่นในรูป
ถ้าแถว STD อ่านไม่ชัดหรือไม่มีวันที่ ให้ตอบ วันที่ : ไม่ชัด
กติการูปแบบ: วันที่ต้องเป็น DD Mon YYYY, เลขทริปต้องขึ้นต้นด้วย LT ตามด้วยตัวอักษรอังกฤษ/ตัวเลขติดกันไม่มีช่องว่าง, เส้นทางใช้เครื่องหมาย > คั่นรหัสต้นทาง-ปลายทาง
อ่านตัวอักษรไทย (สระและวรรณยุกต์) อย่างระมัดระวัง ถ้าแยกตัวอักษรไม่ออกจริง ๆ ให้ตอบ ไม่ชัด ห้ามเดา
อย่าครอบด้วย Markdown, JSON, หรือโค้ดบล็อก
ถ้าช่องไหนอ่านไม่ชัดให้ใส่ ไม่ชัด หลังเครื่องหมาย : ของช่องนั้น

ตัวอย่างรูปแบบคำตอบที่ถูกต้อง (เป็นเพียงตัวอย่างรูปแบบ ห้ามคัดลอกค่าเหล่านี้ถ้าไม่ตรงกับรูปจริง):
${LINE_IMAGE_EXAMPLE_OUTPUT}`;
export const DEFAULT_CODEX_IMAGE_MODEL = "gpt-5.5";
export const CODEX_IMAGE_SYSTEM_PROMPT = "Follow the user's image-reading instructions exactly and return only the requested answer.";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ReadImageWithCodexOptions {
  imagePath: string;
  mimeType: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
}

export function resolveCodexImageModel(model?: string): string {
  return model?.trim() || DEFAULT_CODEX_IMAGE_MODEL;
}

export function buildCodexExecSettings(): CodexExecSettings {
  return {
    allowNpx: true,
    skipGitRepoCheck: true,
    approvalMode: "never",
    sandboxMode: "read-only",
    logger: false,
  };
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

export async function readImageWithCodex(options: ReadImageWithCodexOptions): Promise<string> {
  const image = await readFile(options.imagePath);
  const modelId = resolveCodexImageModel(options.model);
  const useCodexDevice = env.CODEX_IMAGE_PROVIDER === "codex-device"
    || (env.CODEX_IMAGE_PROVIDER === "auto" && await hasCodexDeviceAuth());
  const { text } = await generateText({
    model: useCodexDevice
      ? codexDeviceModel(modelId)
      : codexExec(modelId, buildCodexExecSettings()),
    system: CODEX_IMAGE_SYSTEM_PROMPT,
    abortSignal: AbortSignal.timeout(options.timeoutMs),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: options.prompt.trim() || DEFAULT_CODEX_IMAGE_PROMPT },
          { type: "file", data: image, mediaType: options.mimeType },
        ],
      },
    ],
  });

  return text.trim();
}
