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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { getLineBotSession, saveLineBotSession } from "../repositories/line-bot-session-repository.js";

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

// ── Constants ──────────────────────────────────────────────────────────

const LINEJS_PACKAGE = "@evex/linejs";
const LINEJS_STORAGE_PACKAGE = "@evex/linejs/storage";
const QR_WAIT_MS = 2500;

// ── Singleton state ────────────────────────────────────────────────────

let client: LineJsClient | null = null;
let clientPromise: Promise<LineJsClient> | null = null;
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

async function readStoredAuthToken(): Promise<{ token: string; device: string } | null> {
  // Try DB first
  const dbSession = await getLineBotSession();
  if (dbSession) return { token: dbSession.authToken, device: dbSession.device };

  // Fallback to file
  try {
    const raw = await readFile(getAuthTokenPath(), "utf-8");
    const parsed = JSON.parse(raw) as { token?: string; device?: string };
    if (parsed.token) return { token: parsed.token, device: parsed.device || env.LINEJS_TEST_DEVICE };
    return null;
  } catch {
    return null;
  }
}

async function saveAuthToken(token: string, device = env.LINEJS_TEST_DEVICE): Promise<void> {
  // Try DB first
  const dbOk = await saveLineBotSession(token, device);
  if (dbOk) return;

  // Fallback to file
  try {
    await mkdir(dirname(getAuthTokenPath()), { recursive: true });
    await writeFile(getAuthTokenPath(), JSON.stringify({ token, device, savedAt: new Date().toISOString() }));
  } catch (error) {
    logger.warn("line-bot-auth-token-save-failed", { error: error instanceof Error ? error.message : String(error) });
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
            logger.warn("line-bot-qr-required", { qrUrl: url });
          },
          onPincodeRequest(pincode: string) {
            currentPincode = pincode;
            logger.warn("line-bot-pincode-required", { pincode });
          },
        },
        {
          device: env.LINEJS_TEST_DEVICE,
          storage: new FileStorage(storagePath),
        },
      );

      client = c;
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
      if (errMsg.includes("E2EE_RETRY_PLAIN")) {
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
 * Format error message with helpful hint if linejs is missing.
 */
export function formatError(error: unknown): string {
  if (error instanceof LineBotQrRequiredError) return error.message;

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("@evex/linejs")
    ? `${message}. Install with: npx jsr add @evex/linejs`
    : message;
}
