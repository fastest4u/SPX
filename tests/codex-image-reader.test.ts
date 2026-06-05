import assert from "node:assert/strict";
import {
  DEFAULT_CODEX_IMAGE_PROMPT,
  buildCodexExecSettings,
  isSupportedImageMimeType,
  resolveCodexImageModel,
} from "../src/services/codex-image-reader.js";

const expectedPrompt = `อ่านข้อมูลจากรูปเอกสาร SPX Linehaul Trip Runsheet แล้วตอบกลับเฉพาะ 6 บรรทัดนี้เท่านั้น ห้ามสรุป ห้ามตัดคำ ห้ามแสดงข้อความอื่น:
วันที่ : <วันที่จากแถว STD เท่านั้น เช่น STD: 2026/06/05 21:00:00 ให้ตอบ 05 Jun 2026>
เลขทริป : <เลขทริปในรูป เช่น LT0Q5L2657AJ2>
ชื่อคนขับ : <คัดลอกค่าทั้งหมดหลัง "ชื่อคนขับ:" รวมรหัส agency เลขทะเบียน ประเภทรถ ชื่อคน และ - SUB ถ้ามี>
ชื่อ Agency: <ชื่อ Agency ในรูป>
ประเภทรถ: <ประเภทรถในรูป>
เส้นทาง : <เส้นทางในรูป เช่น NERC-B > SOCE>

กติกาวันที่: ใช้เฉพาะแถวที่ขึ้นต้นว่า STD เท่านั้น ห้ามใช้วันที่ในชื่อทริป, Slot, STA, เวลา Seal, หรือวันที่อื่นในรูป
ถ้าแถว STD อ่านไม่ชัดหรือไม่มีวันที่ ให้ตอบ วันที่ : ไม่ชัด
อย่าครอบด้วย Markdown, JSON, หรือโค้ดบล็อก
ถ้าช่องไหนอ่านไม่ชัดให้ใส่ ไม่ชัด หลังเครื่องหมาย : ของช่องนั้น`;

assert.equal(DEFAULT_CODEX_IMAGE_PROMPT, expectedPrompt);

assert.equal(resolveCodexImageModel(" gpt-5.5 "), "gpt-5.5");
assert.equal(resolveCodexImageModel(""), "gpt-5.5");
assert.deepEqual(buildCodexExecSettings(), {
  allowNpx: true,
  skipGitRepoCheck: true,
  approvalMode: "never",
  sandboxMode: "read-only",
  logger: false,
});

assert.equal(isSupportedImageMimeType("image/png"), true);
assert.equal(isSupportedImageMimeType("image/jpeg"), true);
assert.equal(isSupportedImageMimeType("application/pdf"), false);
