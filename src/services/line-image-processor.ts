import { DEFAULT_CODEX_IMAGE_PROMPT, readImageWithCodex } from "./codex-image-reader.js";
import {
  persistValidLineImageExtraction,
  readLineImageWithRetry,
  validateLineImageExtraction,
  type LineImageReadResult,
} from "./line-image-extraction.js";
import {
  readLineImageViaOcrService,
  type OcrServiceClientOptions,
  type OcrServiceReadResult,
} from "./ocr-service-client.js";
import type { OcrLineImageMimeType, OcrLineImageRequest } from "./ocr-service-contract.js";

export interface LocalLineImageReadInput {
  tempImagePath: string;
  mimeType: OcrLineImageMimeType;
  prompt: string;
  timeoutMs: number;
}

export interface ProcessLineImageOptions {
  tempImagePath: string;
  imageBuffer: Buffer;
  mimeType: OcrLineImageMimeType;
  chatId: string;
  senderId: string;
  traceId: string;
  timeoutMs: number;
  prompt?: string;
  ocrServiceUrl?: string;
  sharedSecret: string;
  nodeId: string;
  ocrServiceRequestTimeoutMs: number;
  readRemoteLineImage?: (
    options: OcrServiceClientOptions,
    request: OcrLineImageRequest,
  ) => Promise<OcrServiceReadResult>;
  readLocalLineImage?: (input: LocalLineImageReadInput) => Promise<LineImageReadResult>;
  persistExtraction?: typeof persistValidLineImageExtraction;
}

export interface ProcessLineImageResult {
  replyText: string;
  read: LineImageReadResult;
  saved: Awaited<ReturnType<typeof persistValidLineImageExtraction>>;
  usedRemoteOcr: boolean;
}

async function defaultReadLocalLineImage(
  input: LocalLineImageReadInput,
): Promise<LineImageReadResult> {
  return readLineImageWithRetry(
    (promptOverride) =>
      readImageWithCodex({
        imagePath: input.tempImagePath,
        mimeType: input.mimeType,
        prompt: promptOverride ?? input.prompt,
        timeoutMs: input.timeoutMs,
      }),
    input.prompt,
  );
}

function ocrServiceResultToReadResult(
  result: Extract<OcrServiceReadResult, { ok: true }>,
): LineImageReadResult {
  return {
    text: result.text,
    attempts: result.attempts,
    validation: validateLineImageExtraction(result.text),
  };
}

function buildReplyText(
  text: string,
  saved: Awaited<ReturnType<typeof persistValidLineImageExtraction>>,
): string {
  return saved.saved
    ? `${text}\n\nSaved to DB: #${saved.id}`
    : `${text}\n\nNot saved to DB: ${saved.reason}`;
}

export async function processLineImage(
  options: ProcessLineImageOptions,
): Promise<ProcessLineImageResult> {
  const remoteUrl = options.ocrServiceUrl?.trim() ?? "";
  const prompt = options.prompt ?? DEFAULT_CODEX_IMAGE_PROMPT;
  const readRemote = options.readRemoteLineImage ?? readLineImageViaOcrService;
  const readLocal = options.readLocalLineImage ?? defaultReadLocalLineImage;
  const persistExtraction = options.persistExtraction ?? persistValidLineImageExtraction;

  let read: LineImageReadResult;
  let usedRemoteOcr = false;
  if (remoteUrl) {
    const result = await readRemote(
      {
        baseUrl: remoteUrl,
        sharedSecret: options.sharedSecret,
        nodeId: options.nodeId,
        requestTimeoutMs: options.ocrServiceRequestTimeoutMs,
      },
      {
        imageBase64: options.imageBuffer.toString("base64"),
        mimeType: options.mimeType,
        traceId: options.traceId,
        chatId: options.chatId,
        senderId: options.senderId,
      },
    );
    if (!result.ok) {
      throw new Error(`OCR service failed: ${result.error}`);
    }
    read = ocrServiceResultToReadResult(result);
    usedRemoteOcr = true;
  } else {
    read = await readLocal({
      tempImagePath: options.tempImagePath,
      mimeType: options.mimeType,
      prompt,
      timeoutMs: options.timeoutMs,
    });
  }

  const saved = await persistExtraction({
    tempImagePath: options.tempImagePath,
    chatId: options.chatId,
    senderId: options.senderId,
    aiText: read.text,
  });

  return {
    replyText: buildReplyText(read.text, saved),
    read,
    saved,
    usedRemoteOcr,
  };
}
