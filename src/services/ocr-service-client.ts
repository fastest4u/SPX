import { signedJsonPost } from "./internal-service-client.js";
import {
  OCR_INTERNAL_READ_LINE_IMAGE_PATH,
  type OcrLineImageRequest,
  type OcrLineImageResponse,
} from "./ocr-service-contract.js";

export interface OcrServiceClientOptions {
  baseUrl: string;
  sharedSecret: string;
  nodeId: string;
  requestTimeoutMs: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export type OcrServiceReadResult =
  | (OcrLineImageResponse & { ok: true; retryable: false })
  | { ok: false; error: string; retryable: boolean };

function ocrServiceUrl(baseUrl: string): string {
  return new URL(OCR_INTERNAL_READ_LINE_IMAGE_PATH, baseUrl).toString();
}

export async function readLineImageViaOcrService(
  options: OcrServiceClientOptions,
  request: OcrLineImageRequest,
): Promise<OcrServiceReadResult> {
  let url: string;
  try {
    url = ocrServiceUrl(options.baseUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  const result = await signedJsonPost<OcrLineImageRequest, OcrLineImageResponse>({
    url,
    sharedSecret: options.sharedSecret,
    nodeId: options.nodeId,
    body: request,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      retryable: result.retryable,
    };
  }

  return {
    ok: true,
    text: result.data.text,
    attempts: result.data.attempts,
    validation: result.data.validation,
    retryable: false,
  };
}
