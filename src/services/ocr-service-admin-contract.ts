export const OCR_INTERNAL_ADMIN_STATUS_PATH = "/internal/ocr/admin/status";
export const OCR_INTERNAL_ADMIN_START_PATH = "/internal/ocr/admin/start";
export const OCR_INTERNAL_ADMIN_COMPLETE_PATH = "/internal/ocr/admin/complete";
export const OCR_INTERNAL_ADMIN_LOGOUT_PATH = "/internal/ocr/admin/logout";

export type OcrAdminCommand =
  | { kind: "status" }
  | { kind: "start"; mode: "browser" | "device" }
  | { kind: "complete"; input: string }
  | { kind: "logout" };

export interface PublicOcrAuthStatus {
  authenticated: boolean;
  provider: "codex-device";
  expiresAt: string | null;
}
