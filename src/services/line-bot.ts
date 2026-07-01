/**
 * LINE Bot Service — manages linejs client lifecycle.
 *
 * Responsibilities:
 *   • QR-code login flow (non-blocking, race-safe)
 *   • Auth-token persistence via FileStorage
 *   • Sending messages (user or group)
 *   • Exposing login status for Web UI / API
 *
 * This module is the single owner of the linejs client singleton.
 * Other modules (notifier, controllers) import from here instead
 * of touching @evex/linejs directly.
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { decryptString, encryptString } from "../utils/crypto.js";
import { deleteLineBotSession, getLineBotSession, saveLineBotSession } from "../repositories/line-bot-session-repository.js";

// ── Types (duck-typed to keep @evex/linejs as a lazy dynamic import) ───

type LineJsClient = {
  base: {
    talk: {
      sendMessage(input: { to: string; text: string; contentType?: string; e2ee?: boolean }): Promise<unknown>;
      getProfile(): Promise<{ displayName: string; mid: string; statusMessage?: string }>;
      getAllChatMids(args: { syncReason: string; request: { withMemberChats: boolean } }): Promise<{ memberChatMids: string[] }>;
      getChats(args: { chatMids: string[] }): Promise<{ chats: Array<{ chatMid: string; chatName: string }> }>;
    };
  };
  authToken: string;
  on(event: string, handler: (...args: unknown[]) => void): void;
  listen(opts: { talk?: boolean }): void;
};

type LineImageMessage = {
  raw: { contentType?: string };
  to: { id: string; type: string };
  from: { id: string };
  getData(): Promise<Blob>;
  reply(text: string): Promise<void>;
};

type LineJsLoginModule = {
  loginWithQR(credentials: {
    onReceiveQRUrl(url: string): void | Promise<void>;
    onPincodeRequest(pincode: string): void | Promise<void>;
  }, options: { device: string; storage: unknown }): Promise<LineJsClient>;

  loginWithAuthToken(token: string, options: { device: string; storage: unknown }): Promise<LineJsClient>;
};

type LineJsStorageModule = {
  FileStorage: new (path: string) => unknown;
};

// ── Public types ───────────────────────────────────────────────────────

export type LineBotStatus = {
  enabled: boolean;
  authenticated: boolean;
  qrUrl?: string;
  pincode?: string;
  message: string;
};

export type LineBotSendResult = {
  ok: boolean;
  error?: string;
  qrUrl?: string;
  pincode?: string;
};

export type LineBotProfile = {
  displayName: string;
  mid: string;
  statusMessage?: string;
  pictureUrl?: string;
};

export type LineBotStorageHealth = {
  storagePath: string;
  exists: boolean;
  sizeBytes: number;
  hasE2EEKeys: boolean;
  hasAuthState: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────

const LINEJS_PACKAGE = "@evex/linejs";
const LINEJS_STORAGE_PACKAGE = "@evex/linejs/storage";
const QR_WAIT_MS = 2500;
const LINE_IMAGE_READ_FAILED_PREFIX = "\u0e2d\u0e48\u0e32\u0e19\u0e23\u0e39\u0e1b\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08";
const SUPPORTED_LINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LINE_LISTENER_RECONNECT_DELAY_MS = 5000;
const RECOVERABLE_LINEJS_LISTENER_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|network/i;
const LINEJS_LISTENER_STACK_MARKER =
  /@evex[\\/](?:linejs|__linejs)|@jsr[\\/]evex__linejs|node_modules[\\/]@evex[\\/]linejs|linejs[\\/]client|linejs[\\/]base[\\/]polling|initLegyPusher|listenTalkEvents/i;

// ── Singleton state ────────────────────────────────────────────────────

let client: LineJsClient | null = null;
let clientPromise: Promise<LineJsClient> | null = null;
// Image-listener binding. `imageListenerChatId` is the configured target chat
// (persists across relogin); `imageListenerClient` tracks which client instance
// currently has the handler so it is re-attached after a logout/relogin rebuild.
let imageListenerChatId = "";
let imageListenerClient: LineJsClient | null = null;
let imageListenerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentQrUrl = "";
let currentPincode = "";
let qrUrlWaiter: ((url: string) => void) | null = null;

// ── Error class ────────────────────────────────────────────────────────

export class LineBotQrRequiredError extends Error {
  constructor(
    public readonly qrUrl?: string,
    public readonly pincode?: string,
  ) {
    super(
      qrUrl
        ? "LINE Bot QR login required — scan the QR code, then retry."
        : "LINE Bot QR login is starting — retry shortly.",
    );
  }
}

// ── Auth-failure detection / session reset ─────────────────────────────

/**
 * Heuristically detect a LINE authentication failure (expired/revoked token,
 * unauthorized request) from an error thrown by the linejs client. Used to
 * decide whether a previously "authenticated" client is actually dead.
 */
function isLineAuthFailure(error: unknown): boolean {
  if (error instanceof LineBotQrRequiredError) return false;
  const name = error instanceof Error ? error.name : "";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return name === "TalkException"
    || /authentication\s*fail/.test(message)
    || /auth\s*token/.test(message)
    || /not\s*authorized/.test(message)
    || /unauthorized/.test(message)
    || /must_refresh_v3_token/.test(message)
    || /access\s*token/.test(message)
    || /invalid.*token/.test(message)
    || /token.*(expired|invalid|revoked)/.test(message);
}

/**
 * Clear the cached client + in-flight login promise so a dead/expired session
 * stops being reported as "authenticated" by getStatus()/getProfile(). The next
 * getClient() call rebuilds from a stored token or starts a fresh QR login.
 * The configured image-listener target chat id is intentionally retained; the
 * listener binding is dropped so it re-attaches on the rebuilt client.
 */
function clearAuthenticatedSession(reason: string): void {
  if (!client && !clientPromise && !imageListenerClient) return;
  client = null;
  clientPromise = null;
  imageListenerClient = null;
  logger.warn("line-bot-session-cleared", { reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDiagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error
    ? `\n${error.cause.message}\n${error.cause.stack ?? ""}`
    : "";
  return `${error.message}\n${error.stack ?? ""}${cause}`;
}

export function isRecoverableLineJsListenerRejection(reason: unknown): boolean {
  const text = errorDiagnosticText(reason);
  return RECOVERABLE_LINEJS_LISTENER_ERROR.test(text) && LINEJS_LISTENER_STACK_MARKER.test(text);
}

function scheduleImageListenerReconnect(reason: string): void {
  if (!imageListenerChatId || !isLineBotEnabled() || imageListenerReconnectTimer) return;
  clearAuthenticatedSession(reason);

  imageListenerReconnectTimer = setTimeout(() => {
    imageListenerReconnectTimer = null;
    const targetChatId = imageListenerChatId;
    if (!targetChatId || !isLineBotEnabled()) return;

    void startImageListener(targetChatId).catch((error) => {
      logger.warn("line-image-listener-reconnect-failed", {
        error: errorMessage(error),
      });
      if (isLineAuthFailure(error)) {
        clearAuthenticatedSession("line-image-listener-reconnect-auth-failure");
        return;
      }
      scheduleImageListenerReconnect("line-image-listener-reconnect-retry");
    });
  }, LINE_LISTENER_RECONNECT_DELAY_MS);
  imageListenerReconnectTimer.unref?.();
}

export function handleRecoverableLineJsListenerRejection(reason: unknown): boolean {
  if (!imageListenerChatId || !isLineBotEnabled() || !isRecoverableLineJsListenerRejection(reason)) return false;

  logger.warn("line-image-listener-polling-failed", {
    error: errorMessage(reason),
    action: "reconnect",
  });
  scheduleImageListenerReconnect("line-image-listener-polling-failed");
  return true;
}

// ── Enable check ───────────────────────────────────────────────────────

export function isLineBotEnabled(): boolean {
  return env.LINEJS_TEST_ENABLED;
}

// ── Lazy module loader ─────────────────────────────────────────────────

async function loadLinejsModules(): Promise<{ linejs: LineJsLoginModule; FileStorage: LineJsStorageModule["FileStorage"] }> {
  const [linejs, storage] = await Promise.all([
    import(LINEJS_PACKAGE) as Promise<LineJsLoginModule>,
    import(LINEJS_STORAGE_PACKAGE) as Promise<LineJsStorageModule>,
  ]);
  return { linejs, FileStorage: storage.FileStorage };
}

function getStoragePath(): string {
  return resolve(process.cwd(), env.LINEJS_TEST_STORAGE_PATH);
}

function getAuthTokenPath(): string {
  return resolve(process.cwd(), "data/linejs-auth-token.json");
}

async function hasStoredE2EEKeys(): Promise<boolean> {
  try {
    const raw = await readFile(getStoragePath(), "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(data).some((key) => key.startsWith("e2eeKeys:"));
  } catch {
    return false;
  }
}

async function readStoredAuthToken(): Promise<{ token: string; device: string } | null> {
  if (env.LINE_IMAGE_LISTENER_CHAT_ID && !(await hasStoredE2EEKeys())) {
    logger.warn("line-bot-skip-token-restore-missing-e2ee-keys", {
      reason: "image listener requires E2EE keys to read incoming encrypted media",
    });
    return null;
  }

  // Try DB first
  const dbSession = await getLineBotSession();
  if (dbSession) return { token: dbSession.authToken, device: dbSession.device };

  // Fallback to file (encrypted at rest, falls back to legacy plaintext for migration)
  try {
    const raw = await readFile(getAuthTokenPath(), "utf-8");
    const parsed = JSON.parse(raw) as { token?: string; device?: string };
    const decryptedToken = parsed.token ? decryptString(parsed.token) : "";
    if (decryptedToken) return { token: decryptedToken, device: parsed.device || env.LINEJS_TEST_DEVICE };
    return null;
  } catch {
    return null;
  }
}

async function saveAuthToken(token: string, device = env.LINEJS_TEST_DEVICE): Promise<void> {
  // Always write to file for Docker restart resilience. Token is encrypted at rest;
  // file mode is locked down to owner-read/write so other users on the host cannot read it.
  try {
    await mkdir(dirname(getAuthTokenPath()), { recursive: true });
    const payload = JSON.stringify({
      token: encryptString(token),
      device,
      savedAt: new Date().toISOString(),
    });
    await writeFile(getAuthTokenPath(), payload);
    try { await chmod(getAuthTokenPath(), 0o600); } catch { /* best effort on Windows */ }
  } catch (error) {
    logger.warn("line-bot-auth-token-file-save-failed", { error: error instanceof Error ? error.message : String(error) });
  }

  // Also try DB (encryption handled inside the repository).
  try {
    await saveLineBotSession(token, device);
  } catch {
    // ignore DB errors
  }
}

// ── Client acquisition (QR flow) ──────────────────────────────────────

/**
 * Get or create the LINE bot client.
 * If not yet authenticated, starts QR login and throws `LineBotQrRequiredError`
 * so the caller can present the QR URL to the user.
 */
export async function getClient(): Promise<LineJsClient> {
  if (client) return client;

  if (!clientPromise) {
    clientPromise = (async () => {
      const { linejs, FileStorage } = await loadLinejsModules();
      const storagePath = getStoragePath();
      await mkdir(dirname(storagePath), { recursive: true });

      // Try restore from stored auth token first
      const storedToken = await readStoredAuthToken();
      if (storedToken) {
        try {
          const c = await linejs.loginWithAuthToken(storedToken.token, {
            device: storedToken.device,
            storage: new FileStorage(storagePath),
          });
          client = c;
          attachImageListener(c);
          logger.info("line-bot-restored-from-token");
          return c;
        } catch (error) {
          logger.warn("line-bot-token-restore-failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Fall back to QR login
      const c = await linejs.loginWithQR(
        {
          onReceiveQRUrl(url: string) {
            currentQrUrl = url;
            qrUrlWaiter?.(url);
            qrUrlWaiter = null;
            logger.warn("line-bot-qr-required", { qrIssued: true });
          },
          onPincodeRequest(pincode: string) {
            currentPincode = pincode;
            logger.warn("line-bot-pincode-required", { pinIssued: true });
          },
        },
        {
          device: env.LINEJS_TEST_DEVICE,
          storage: new FileStorage(storagePath),
        },
      );

      client = c;
      attachImageListener(c);
      currentQrUrl = "";
      currentPincode = "";
      await saveAuthToken(c.authToken);
      logger.info("line-bot-authenticated");
      return c;
    })().catch((error) => {
      clientPromise = null;
      client = null;
      throw error;
    });
  }

  // Race: either login completes or we get the QR URL within timeout
  const result = await Promise.race([
    clientPromise.then((c) => ({ kind: "client" as const, client: c })),
    waitForQrUrl(QR_WAIT_MS),
  ]);

  if (result.kind === "client") return result.client;

  throw new LineBotQrRequiredError(result.qrUrl, currentPincode || undefined);
}

function waitForQrUrl(timeoutMs: number): Promise<{ kind: "qr"; qrUrl?: string }> {
  if (currentQrUrl) {
    return Promise.resolve({ kind: "qr", qrUrl: currentQrUrl });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (qrUrlWaiter === resolveWithQr) qrUrlWaiter = null;
      resolve({ kind: "qr", qrUrl: currentQrUrl || undefined });
    }, timeoutMs);

    const resolveWithQr = (url: string) => {
      clearTimeout(timeout);
      resolve({ kind: "qr", qrUrl: url });
    };

    qrUrlWaiter = resolveWithQr;
  });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Request QR login (called by Web UI or API).
 * Returns current status: already logged in, or QR URL to scan.
 */
export async function requestQrLogin(): Promise<LineBotStatus> {
  if (!isLineBotEnabled()) {
    return {
      enabled: false,
      authenticated: false,
      message: "LINE Bot is disabled (LINEJS_TEST_ENABLED=false or NODE_ENV=production)",
    };
  }

  try {
    await getClient();
    return {
      enabled: true,
      authenticated: true,
      message: "LINE Bot is already authenticated",
    };
  } catch (error) {
    if (error instanceof LineBotQrRequiredError) {
      return {
        enabled: true,
        authenticated: false,
        qrUrl: error.qrUrl,
        pincode: error.pincode,
        message: error.message,
      };
    }
    throw error;
  }
}

/**
 * Send a text message to a user or group.
 * @param to  - MID of user (u...) or group (c...)
 * @param text - message text
 */
export async function sendMessage(to: string, text: string): Promise<LineBotSendResult> {
  if (!isLineBotEnabled()) {
    return { ok: false, error: "LINE Bot is disabled" };
  }

  try {
    const c = await getClient();
    try {
      await c.base.talk.sendMessage({ to, text, e2ee: true });
    } catch (e2eeError: unknown) {
      const errMsg = e2eeError instanceof Error ? e2eeError.message : String(e2eeError);
      if (errMsg.includes("E2EE_RETRY_PLAIN") || errMsg.includes("E2EE Key has not been saved")) {
        logger.warn("line-bot-e2ee-fallback-plain", { to, error: errMsg });
        await c.base.talk.sendMessage({ to, text, e2ee: false });
      } else {
        throw e2eeError;
      }
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof LineBotQrRequiredError) {
      return { ok: false, error: error.message, qrUrl: error.qrUrl, pincode: error.pincode };
    }
    if (isLineAuthFailure(error)) {
      clearAuthenticatedSession("send-message-auth-failure");
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

/**
 * Send a notification-style message (title + body).
 * Used by the notifier as a notification channel.
 */
export async function sendNotification(title: string, message: string): Promise<LineBotSendResult> {
  if (!env.LINEJS_TEST_TARGET_ID) {
    return { ok: false, error: "LINEJS_TEST_TARGET_ID is required" };
  }

  const text = `${title}\n${message.length > 4500 ? message.slice(0, 4497) + "..." : message}`;
  return sendMessage(env.LINEJS_TEST_TARGET_ID, text);
}

/**
 * Fetch groups/chats the authenticated account is a member of.
 */
export async function getGroups(): Promise<{ chats: Array<{ chatMid: string; chatName: string }> }> {
  if (!isLineBotEnabled()) {
    return { chats: [] };
  }

  try {
    const c = await getClient();
    const midsResult = await c.base.talk.getAllChatMids({ syncReason: "INITIAL", request: { withMemberChats: true } });
    const chatMids = midsResult.memberChatMids ?? [];
    if (chatMids.length === 0) {
      return { chats: [] };
    }

    // Fetch chat names in batches (API may have limit)
    const batchSize = 50;
    const chats: Array<{ chatMid: string; chatName: string }> = [];
    for (let i = 0; i < chatMids.length; i += batchSize) {
      const batch = chatMids.slice(i, i + batchSize);
      const chatsResult = await c.base.talk.getChats({ chatMids: batch });
      for (const chat of chatsResult.chats ?? []) {
        chats.push({
          chatMid: chat.chatMid,
          chatName: chat.chatName || chat.chatMid,
        });
      }
    }

    return { chats };
  } catch (error) {
    if (error instanceof LineBotQrRequiredError) {
      return { chats: [] };
    }
    logger.error("line-bot-get-groups-failed", { error: error instanceof Error ? error.message : String(error) });
    return { chats: [] };
  }
}

/**
 * Get current LINE bot status (for dashboard/health).
 */
export function getStatus(): LineBotStatus {
  if (!isLineBotEnabled()) {
    return {
      enabled: false,
      authenticated: false,
      message: "LINE Bot is disabled",
    };
  }

  if (client) {
    return {
      enabled: true,
      authenticated: true,
      message: "LINE Bot is connected",
    };
  }

  if (currentQrUrl) {
    return {
      enabled: true,
      authenticated: false,
      qrUrl: currentQrUrl,
      pincode: currentPincode || undefined,
      message: "Waiting for QR scan",
    };
  }

  return {
    enabled: true,
    authenticated: false,
    message: "LINE Bot is not yet logged in",
  };
}

/**
 * Get LINE profile of the authenticated account.
 */
export async function getProfile(): Promise<LineBotProfile | null> {
  if (!isLineBotEnabled()) return null;
  if (!client) return null;

  try {
    const profile = await client.base.talk.getProfile();
    return {
      displayName: profile.displayName,
      mid: profile.mid,
      statusMessage: profile.statusMessage,
      // LINE profile picture is typically at: https://profile.line-scdn.net/xxx
      // but linejs getProfile may not expose it directly
    };
  } catch (error) {
    logger.warn("line-bot-get-profile-failed", { error: error instanceof Error ? error.message : String(error) });
    if (isLineAuthFailure(error)) {
      clearAuthenticatedSession("get-profile-auth-failure");
    }
    return null;
  }
}

/**
 * Check storage health — whether E2EE keys and auth state are persisted.
 */
export async function getStorageHealth(): Promise<LineBotStorageHealth> {
  const storagePath = getStoragePath();

  let exists = false;
  let sizeBytes = 0;
  let hasE2EEKeys = false;
  let hasAuthState = false;

  try {
    const stats = await stat(storagePath);
    exists = true;
    sizeBytes = stats.size;

    if (sizeBytes > 50) {
      const content = await readFile(storagePath, "utf-8");
      const data = JSON.parse(content);
      const keys = Object.keys(data);
      // E2EE keys stored under keys like "e2eeKeys:5843820"
      hasE2EEKeys = keys.some((k) => k.includes("e2ee") || k.includes("keyStore") || k.includes("e2eeKeyIds"));
      // Auth state: qrCert, authToken, cert, etc.
      hasAuthState = keys.some((k) => k.includes("cert") || k.includes("auth") || k.includes("token") || k.includes("meta"));
    }
  } catch {
    // file may not exist yet
  }

  // Also check DB session
  try {
    const dbSession = await getLineBotSession();
    if (dbSession) {
      hasAuthState = true;
    }
  } catch {
    // ignore
  }

  return { storagePath, exists, sizeBytes, hasE2EEKeys, hasAuthState };
}

/**
 * Logout and optionally clear all stored auth data.
 * @param clearStorage — also delete persisted storage files
 */
export async function logout(clearStorage = false): Promise<void> {
  client = null;
  clientPromise = null;
  currentQrUrl = "";
  currentPincode = "";
  qrUrlWaiter = null;
  // Drop the listener binding so the next rebuilt client re-attaches the image
  // handler. The configured target chat id is intentionally retained.
  imageListenerClient = null;

  if (clearStorage) {
    try {
      await deleteLineBotSession();
    } catch {
      // ignore
    }
    try {
      const storagePath = getStoragePath();
      if (existsSync(storagePath)) {
        await unlink(storagePath);
      }
    } catch {
      // ignore
    }
    try {
      const authPath = getAuthTokenPath();
      if (existsSync(authPath)) {
        await unlink(authPath);
      }
    } catch {
      // ignore
    }
  }

  logger.info("line-bot-logout", { clearStorage });
}

// ── Image listener ────────────────────────────────────────────────────

function getModuleExport<T>(module: unknown, name: string): T {
  const record = module as Record<string, unknown>;
  const direct = record[name];
  if (direct) return direct as T;

  const defaultRecord = record.default as Record<string, unknown> | undefined;
  const defaultExport = defaultRecord?.[name];
  if (defaultExport) return defaultExport as T;

  const cjsRecord = record["module.exports"] as Record<string, unknown> | undefined;
  const cjsExport = cjsRecord?.[name];
  if (cjsExport) return cjsExport as T;

  throw new Error(`Module export not found: ${name}`);
}

export function isLineImageReadTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError"
    || name === "TimeoutError"
    || /timeout/i.test(message)
    || /aborted/i.test(message);
}

export function formatLineImageListenerError(error: unknown, timeoutMs: number): string {
  if (isLineImageReadTimeout(error)) {
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    return `${LINE_IMAGE_READ_FAILED_PREFIX}: OCR timeout after ${timeoutSeconds}s. Please resend/crop clearer image.`;
  }
  return `${LINE_IMAGE_READ_FAILED_PREFIX}: OCR failed. Please try again.`;
}

function sniffImageMimeType(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extensionForLineImageMimeType(mimeType: string): ".jpg" | ".png" | ".webp" {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

export async function bufferLineImageBlob(blob: Blob, maxBytes: number): Promise<{ buffer: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" }> {
  const declaredType = blob.type.trim().toLowerCase();
  if (declaredType && !SUPPORTED_LINE_IMAGE_MIME_TYPES.has(declaredType)) {
    throw new Error("Unsupported LINE image type. Supported image types are JPEG, PNG, and WebP.");
  }
  if (Number.isFinite(blob.size) && blob.size > maxBytes) {
    throw new Error(`LINE image is too large. Image must be ${maxBytes} bytes or smaller.`);
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`LINE image is too large. Image must be ${maxBytes} bytes or smaller.`);
  }

  const sniffedType = sniffImageMimeType(buffer);
  if (!sniffedType) {
    throw new Error("Unsupported LINE image content. Supported image types are JPEG, PNG, and WebP.");
  }
  if (declaredType && declaredType !== sniffedType) {
    throw new Error("LINE image MIME type does not match its content.");
  }

  return { buffer, mimeType: sniffedType };
}

async function replyToLineImageMessage(msg: LineImageMessage, text: string): Promise<boolean> {
  try {
    await msg.reply(text);
    return true;
  } catch (primaryError) {
    logger.warn("line-image-listener-primary-reply-failed", {
      to: msg.to?.id,
      error: primaryError instanceof Error ? primaryError.message : String(primaryError),
    });
  }

  const fallback = await sendMessage(msg.to.id, text);
  if (!fallback.ok) {
    logger.warn("line-image-listener-fallback-reply-failed", {
      to: msg.to?.id,
      error: fallback.error,
    });
    return false;
  }
  return true;
}

export async function startImageListener(targetChatMid: string): Promise<void> {
  if (!isLineBotEnabled()) return;
  if (!targetChatMid) return;

  // Remember the target so the handler is (re)attached automatically on every
  // client (re)build — see attachImageListener() called from getClient().
  imageListenerChatId = targetChatMid;
  const c = await getClient();
  attachImageListener(c);
}

/**
 * Attach the image-message handler to a specific client instance. Idempotent
 * per client and re-invoked after a logout/relogin rebuild so the OCR pipeline
 * keeps working. (The previous implementation set a permanent module flag that
 * logout() never reset, so the listener silently died after the first relogin.)
 */
function attachImageListener(c: LineJsClient): void {
  if (!imageListenerChatId) return;
  if (imageListenerClient === c) return;
  imageListenerClient = c;

  c.on("message", async (rawMessage: unknown) => {
    const msg = rawMessage as LineImageMessage;
    if (msg.raw?.contentType !== "IMAGE") return;
    if (msg.to?.id !== imageListenerChatId) return;

    let tempDir = "";
    const startedAt = Date.now();
    const timeoutMs = env.CODEX_IMAGE_TIMEOUT_MS;
    logger.info("line-image-listener-received", {
      to: msg.to?.id,
      from: msg.from?.id,
      contentType: msg.raw?.contentType,
      timeoutMs,
    });
    try {
      const blob = await msg.getData();
      const { buffer, mimeType } = await bufferLineImageBlob(blob, env.CODEX_IMAGE_MAX_BYTES);

      tempDir = await mkdtemp(join(tmpdir(), "spx-line-image-"));
      const imagePath = join(tempDir, `line-upload${extensionForLineImageMimeType(mimeType)}`);

      await pipeline(Readable.from(buffer), createWriteStream(imagePath, { flags: "wx" }));

      // Lazy-load to avoid circular import
      const codexImageReader = await import("./codex-image-reader.js");
      const readImageWithCodex = getModuleExport<typeof import("./codex-image-reader.js").readImageWithCodex>(
        codexImageReader,
        "readImageWithCodex"
      );
      const defaultPrompt = getModuleExport<typeof import("./codex-image-reader.js").DEFAULT_CODEX_IMAGE_PROMPT>(
        codexImageReader,
        "DEFAULT_CODEX_IMAGE_PROMPT"
      );
      const lineImageExtraction = await import("./line-image-extraction.js");
      const readLineImageWithRetry = getModuleExport<typeof import("./line-image-extraction.js").readLineImageWithRetry>(
        lineImageExtraction,
        "readLineImageWithRetry"
      );
      const persistValidLineImageExtraction = getModuleExport<typeof import("./line-image-extraction.js").persistValidLineImageExtraction>(
        lineImageExtraction,
        "persistValidLineImageExtraction"
      );
      const codexStartedAt = Date.now();
      logger.info("line-image-listener-codex-start", {
        to: msg.to.id,
        bytes: buffer.byteLength,
        timeoutMs,
      });
      // One read plus at most one feedback-guided retry when the reply fails
      // field-format validation (misread trip number / date / route).
      const read = await readLineImageWithRetry(
        (promptOverride) => readImageWithCodex({
          imagePath,
          mimeType,
          prompt: promptOverride ?? "", // default 6-field prompt on the first pass
          timeoutMs,
        }),
        defaultPrompt,
      );
      const text = read.text;
      if (read.attempts > 1) {
        logger.info("line-image-listener-retried", {
          to: msg.to.id,
          attempts: read.attempts,
          ok: read.validation.ok,
          reason: read.validation.ok ? undefined : read.validation.reason,
        });
      }
      logger.info("line-image-listener-codex-finished", {
        to: msg.to.id,
        durationMs: Date.now() - codexStartedAt,
        textLength: text.length,
        attempts: read.attempts,
      });
      const saved = await persistValidLineImageExtraction({
        tempImagePath: imagePath,
        chatId: msg.to.id,
        senderId: msg.from.id,
        aiText: text,
      });

      const replyText = saved.saved
        ? `${text}\n\nSaved to DB: #${saved.id}`
        : `${text}\n\nNot saved to DB: ${saved.reason}`;

      const replyDelivered = await replyToLineImageMessage(msg, replyText);
      logger.info("line-image-listener-reply", {
        to: msg.to.id,
        savedToDb: saved.saved,
        extractionId: saved.id,
        reason: saved.reason,
        replyDelivered,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn("line-image-listener-error", {
        to: msg.to?.id,
        error: errMsg,
        timeout: isLineImageReadTimeout(error),
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      await replyToLineImageMessage(msg, formatLineImageListenerError(error, timeoutMs));
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  c.listen({ talk: true });
  logger.info("line-image-listener-started", { targetChatMid: imageListenerChatId });
}

/**
 * Format error message with helpful hint if linejs is missing.
 */
export function formatError(error: unknown): string {
  if (error instanceof LineBotQrRequiredError) return error.message;

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("@evex/linejs")
    ? `${message}. Install with: npx jsr add @evex/linejs`
    : message;
}
