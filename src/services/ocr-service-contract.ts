export const OCR_INTERNAL_READ_LINE_IMAGE_PATH = "/internal/ocr/line-image";

export type OcrLineImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface OcrLineImageRequest {
  imageBase64: string;
  mimeType: OcrLineImageMimeType;
  traceId: string;
  chatId?: string;
  senderId?: string;
}

export interface OcrLineImageResponse {
  text: string;
  attempts: number;
  validation: {
    ok: boolean;
    reason?: string;
  };
}

export function isOcrLineImageMimeType(value: string): value is OcrLineImageMimeType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}
