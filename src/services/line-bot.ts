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

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveOutboundNodeSecret } from "./notification-publisher.js";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { decryptString, encryptString } from "../utils/crypto.js";
import {
  deleteLineBotSession,
  getLineBotSession,
  saveLineBotSession,
} from "../repositories/line-bot-session-repository.js";
import { isLineStatusCommand, handleLineStatusCommand } from "./line-status-command.js";
import { isLineRouteCommand, handleLineRouteCommand } from "./line-route-command.js";

// ── Types (duck-typed to keep @evex/linejs as a lazy dynamic import) ───

type LineJsGroupSharedKey = {
  keyVersion?: number;
  groupKeyId: number;
  creator: string;
  creatorKeyId: number;
  receiver?: string;
  receiverKeyId: number;
  encryptedSharedKey?: Buffer | Uint8Array | string;
  allowedTypes?: number[];
  specVersion?: number;
};

export type LineJsStorageLike = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<void>;
  getAll?(): Promise<Record<string, unknown>> | Record<string, unknown>;
};

type LineJsE2EELike = {
  getE2EESelfKeyDataByKeyId(
    keyId: string | number,
  ): Promise<{ keyId?: string | number; privKey?: string; pubKey?: string } | undefined>;
  getE2EELocalPublicKey(
    mid: string,
    keyId?: string | number,
  ): Promise<Buffer | { privKey: string; keyId: number }>;
  tryRegisterE2EEGroupKey(chatMid: string): Promise<LineJsGroupSharedKey>;
  generateSharedSecret(privateKey: Buffer, publicKey: Buffer): Uint8Array;
  getSHA256Sum(...args: Array<string | Buffer>): Buffer;
  xor(buf: Buffer): Buffer;
  generateAAD(
    to: string,
    from: string,
    senderKeyId: number,
    receiverKeyId: number,
    specVersion?: number,
    contentType?: number,
  ): Buffer;
  decryptE2EEMessageV2(
    to: string,
    from: string,
    chunks: Buffer[],
    privK: Buffer,
    pubK: Buffer,
    specVersion?: number,
    contentType?: number | string,
  ): Record<string, unknown>;
  encryptE2EEMessage(
    to: string,
    data: unknown,
    contentType?: unknown,
    specVersion?: number,
  ): Promise<Buffer[]>;
  decryptE2EEMessage(messageObj: Record<string, unknown>): Promise<Record<string, unknown>>;
};

type LineJsClient = {
  base: {
    talk: {
      sendMessage(input: {
        to: string;
        text: string;
        contentType?: string;
        e2ee?: boolean;
      }): Promise<unknown>;
      getProfile(): Promise<{ displayName: string; mid: string; statusMessage?: string }>;
      getAllChatMids(args: {
        syncReason: string;
        request: { withMemberChats: boolean };
      }): Promise<{ memberChatMids: string[] }>;
      getChats(args: {
        chatMids: string[];
      }): Promise<{ chats: Array<{ chatMid: string; chatName: string }> }>;
      getE2EEPublicKey?(args: {
        mid: string;
        keyVersion: number;
        keyId: number;
      }): Promise<{ version?: number; keyId: number; keyData: Buffer | Uint8Array | string }>;
      getLastE2EEPublicKeys?(args: {
        chatMid: string;
      }): Promise<Record<string, { keyId: number; keyData: Buffer | Uint8Array | string }>>;
      registerE2EEGroupKey?(args: {
        keyVersion: number;
        chatMid: string;
        keyIds: number[];
        members: string[];
        encryptedSharedKeys: Buffer[];
      }): Promise<LineJsGroupSharedKey>;
      getLastE2EEGroupSharedKey?(args: {
        keyVersion: number;
        chatMid: string;
      }): Promise<LineJsGroupSharedKey>;
      getE2EEGroupSharedKey?(args: {
        keyVersion: number;
        chatMid: string;
        groupKeyId: number;
      }): Promise<LineJsGroupSharedKey>;
    };
    profile?: { displayName?: string; mid?: string; statusMessage?: string };
    storage?: LineJsStorageLike;
    getToType?(mid: string): number | null | undefined;
    e2ee?: LineJsE2EELike;
  };
  profile?: { displayName?: string; mid?: string; statusMessage?: string };
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
  loginWithQR(
    credentials: {
      onReceiveQRUrl(url: string): void | Promise<void>;
      onPincodeRequest(pincode: string): void | Promise<void>;
    },
    options: { device: string; storage: unknown },
  ): Promise<LineJsClient>;

  loginWithAuthToken(
    token: string,
    options: { device: string; storage: unknown },
  ): Promise<LineJsClient>;
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
const LINE_IMAGE_READ_FAILED_PREFIX =
  "\u0e2d\u0e48\u0e32\u0e19\u0e23\u0e39\u0e1b\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08";
const SUPPORTED_LINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LINE_LISTENER_RECONNECT_DELAY_MS = 5000;
const RECOVERABLE_LINEJS_LISTENER_ERROR =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|network/i;
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
  return (
    name === "TalkException" ||
    /authentication\s*fail/.test(message) ||
    /auth\s*token/.test(message) ||
    /not\s*authorized/.test(message) ||
    /unauthorized/.test(message) ||
    /must_refresh_v3_token/.test(message) ||
    /access\s*token/.test(message) ||
    /invalid.*token/.test(message) ||
    /token.*(expired|invalid|revoked)/.test(message)
  );
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
  const cause =
    error.cause instanceof Error ? `\n${error.cause.message}\n${error.cause.stack ?? ""}` : "";
  return `${error.message}\n${error.stack ?? ""}${cause}`;
}

export function isRecoverableLineJsListenerRejection(reason: unknown): boolean {
  const text = errorDiagnosticText(reason);
  return RECOVERABLE_LINEJS_LISTENER_ERROR.test(text) && LINEJS_LISTENER_STACK_MARKER.test(text);
}

function scheduleImageListenerReconnect(reason: string): void {
  if (!isLineBotEnabled() || imageListenerReconnectTimer) return;
  clearAuthenticatedSession(reason);

  imageListenerReconnectTimer = setTimeout(() => {
    imageListenerReconnectTimer = null;
    if (!isLineBotEnabled()) return;

    const reconnectAction = imageListenerChatId
      ? startImageListener(imageListenerChatId)
      : getClient();

    void Promise.resolve(reconnectAction).catch((error) => {
      logger.warn("line-listener-reconnect-failed", {
        error: errorMessage(error),
      });
      if (isLineAuthFailure(error)) {
        clearAuthenticatedSession("line-listener-reconnect-auth-failure");
        return;
      }
      scheduleImageListenerReconnect("line-listener-reconnect-retry");
    });
  }, LINE_LISTENER_RECONNECT_DELAY_MS);
  imageListenerReconnectTimer.unref?.();
}

export function handleRecoverableLineJsListenerRejection(reason: unknown): boolean {
  if (!isLineBotEnabled() || !isRecoverableLineJsListenerRejection(reason))
    return false;

  logger.warn("line-listener-polling-failed", {
    error: errorMessage(reason),
    action: "reconnect",
  });
  scheduleImageListenerReconnect("line-listener-polling-failed");
  return true;
}


// ── Enable check ───────────────────────────────────────────────────────

export function isLineBotEnabled(): boolean {
  return env.LINEJS_TEST_ENABLED;
}

// ── Lazy module loader ─────────────────────────────────────────────────

async function loadLinejsModules(): Promise<{
  linejs: LineJsLoginModule;
  FileStorage: LineJsStorageModule["FileStorage"];
}> {
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

const CURVE25519_P = (1n << 255n) - 19n;
const CURVE25519_A24 = 121665n;
const ZERO_32_BYTES = Buffer.alloc(32, 0);
const MAX_HISTORICAL_GROUP_KEYS = 256;
const MAX_DEDUPLICATED_UNCLAMPED_KEYS = 500;
const LINE_CONTENT_TYPE_IDS: Record<string, number> = {
  NONE: 0,
  IMAGE: 1,
  VIDEO: 2,
  AUDIO: 3,
  HTML: 4,
  PDF: 5,
  CALL: 6,
  STICKER: 7,
  PRESENCE: 8,
  GIFT: 9,
  GROUPBOARD: 10,
  APPLINK: 11,
  LINK: 12,
  CONTACT: 13,
  FILE: 14,
  LOCATION: 15,
  POSTNOTIFICATION: 16,
  RICH: 17,
  CHATEVENT: 18,
  MUSIC: 19,
  PAYMENT: 20,
  EXTIMAGE: 21,
  FLEX: 22,
};
const hardenedE2EEInstances = new WeakSet<object>();

function modCurve25519(value: bigint): bigint {
  return ((value % CURVE25519_P) + CURVE25519_P) % CURVE25519_P;
}

function modPowCurve25519(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = modCurve25519(base);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = modCurve25519(result * b);
    }
    b = modCurve25519(b * b);
    e >>= 1n;
  }
  return result;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.byteLength - 1; i >= 0; i -= 1) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

function bigIntToBytes32LE(value: bigint): Buffer {
  const out = Buffer.alloc(32);
  let cur = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return out;
}

function byte2intBE(bytes: Uint8Array): number {
  let result = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    result = 256 * result + bytes[i]!;
  }
  return result;
}

function normalizeE2EEContentType(contentType: unknown): number {
  if (typeof contentType === "number" && Number.isFinite(contentType)) {
    return Math.trunc(contentType);
  }
  if (typeof contentType === "string") {
    const trimmed = contentType.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
    const mapped = LINE_CONTENT_TYPE_IDS[trimmed.toUpperCase()];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return 0;
}

/**
 * Losslessly decode a Thrift binary field returned by @evex/linejs.
 * @evex/linejs `readValue` converts Thrift `STRING`/`BINARY` buffers that happen
 * to be valid UTF-8 via `bin.toString()` (UTF-8), so `Buffer.from(val, "utf-8")`
 * restores the exact original bytes without latin1 truncation.
 */
function toThriftBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf-8");
  }
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  if (
    value &&
    typeof value === "object" &&
    "data" in value &&
    Array.isArray((value as { data: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }
  throw new TypeError("Unsupported Thrift binary field value");
}

/**
 * Return true iff u (masked to 255 bits) is a low-order point on Curve25519 or
 * its quadratic twist (i.e. [8]P = O, projective Z_8 === 0 mod 2^255-19).
 */
function isLowOrderCurve25519U(uRaw: bigint): boolean {
  let x = modCurve25519(uRaw);
  let z = 1n;
  for (let i = 0; i < 3; i += 1) {
    const a = modCurve25519(x + z);
    const aa = modCurve25519(a * a);
    const b = modCurve25519(x - z);
    const bb = modCurve25519(b * b);
    const e = modCurve25519(aa - bb);
    x = modCurve25519(aa * bb);
    z = modCurve25519(e * modCurve25519(aa + modCurve25519(CURVE25519_A24 * e)));
  }
  return z === 0n;
}

function parseStoredJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/**
 * Clamp a 32-byte Curve25519 private scalar per RFC 7748 so clamped and
 * unclamped X25519 implementations (linejs vs Official LINE) derive the exact
 * same shared secret.
 */
export function clampCurve25519Scalar(scalarBytes: Uint8Array): Buffer {
  if (scalarBytes.byteLength !== 32) {
    throw new RangeError(`Curve25519 scalar must be 32 bytes (got ${scalarBytes.byteLength})`);
  }
  const clamped = Buffer.from(scalarBytes);
  clamped[0]! &= 248;
  clamped[31] = (clamped[31]! & 127) | 64;
  return clamped;
}

/**
 * Return true iff a 32-byte scalar already satisfies RFC 7748 Curve25519 clamping.
 */
export function isClampedCurve25519Scalar(scalarBytes: Uint8Array): boolean {
  return (
    scalarBytes.byteLength === 32 &&
    (scalarBytes[0]! & 7) === 0 &&
    (scalarBytes[31]! & 128) === 0 &&
    (scalarBytes[31]! & 64) === 64
  );
}

/**
 * Full 256-bit X25519 Montgomery ladder WITHOUT scalar bit-clamping.
 * Used for Official LINE group key compatibility when TalkServer retains a
 * legacy unclamped group key (e.g. bit 255 = 1). Rejects RFC 7748 low-order
 * public keys and all-zero shared secrets.
 */
export function x25519Unclamped(scalarBytes: Uint8Array, pointBytes: Uint8Array): Buffer {
  if (scalarBytes.byteLength !== 32 || pointBytes.byteLength !== 32) {
    throw new RangeError("x25519Unclamped requires 32-byte scalar and 32-byte point");
  }
  const k = bytesToBigIntLE(scalarBytes);
  const u = bytesToBigIntLE(pointBytes) & ((1n << 255n) - 1n);
  if (isLowOrderCurve25519U(u)) {
    throw new Error("Invalid X25519 public key: low-order point");
  }
  const x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 255; t >= 0; t -= 1) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    const mask = -swap;
    const dx = mask & (x2 ^ x3);
    x2 ^= dx;
    x3 ^= dx;
    const dz = mask & (z2 ^ z3);
    z2 ^= dz;
    z3 ^= dz;
    swap = kt;

    const a = modCurve25519(x2 + z2);
    const aa = modCurve25519(a * a);
    const b = modCurve25519(x2 - z2);
    const bb = modCurve25519(b * b);
    const e = modCurve25519(aa - bb);
    const c = modCurve25519(x3 + z3);
    const d = modCurve25519(x3 - z3);
    const da = modCurve25519(d * a);
    const cb = modCurve25519(c * b);
    const sum = modCurve25519(da + cb);
    const diff = modCurve25519(da - cb);
    x3 = modCurve25519(sum * sum);
    z3 = modCurve25519(x1 * modCurve25519(diff * diff));
    x2 = modCurve25519(aa * bb);
    z2 = modCurve25519(e * modCurve25519(aa + modCurve25519(CURVE25519_A24 * e)));
  }

  const finalMask = -swap;
  const finalDx = finalMask & (x2 ^ x3);
  x2 ^= finalDx;
  x3 ^= finalDx;
  const finalDz = finalMask & (z2 ^ z3);
  z2 ^= finalDz;
  z3 ^= finalDz;

  const out = bigIntToBytes32LE(modCurve25519(x2 * modPowCurve25519(z2, CURVE25519_P - 2n)));
  if (timingSafeEqual(out, ZERO_32_BYTES)) {
    throw new Error("Invalid X25519 public key: low-order point");
  }
  return out;
}

/**
 * Resolve the authenticated user's MID across @evex/linejs Client (`c.base.profile.mid`)
 * and BaseClient/mock shapes (`c.profile.mid`).
 */
export function resolveClientSelfMid(
  c:
    | {
        profile?: { mid?: string };
        base?: { profile?: { mid?: string } };
      }
    | null
    | undefined,
): string | undefined {
  return c?.profile?.mid ?? c?.base?.profile?.mid;
}

/**
 * Synchronize E2EE storage keys in linejs-storage.json (or via a live BaseStorage
 * instance so mutations serialize through FileStorage.writeLock).
 * Ensures the self mid mapping points to the latest registered keyId (supporting
 * both FileStorage JSON-string values and plain object values), and clears stale
 * group keys so fresh group sender keys are negotiated cleanly.
 */
export async function syncE2EEStorageKeys(
  storagePath: string,
  selfMid?: string,
  storage?: LineJsStorageLike,
): Promise<void> {
  try {
    if (storage && typeof storage.getAll === "function" && typeof storage.delete === "function") {
      const data = (await storage.getAll()) ?? {};
      const keyEntries = Object.keys(data)
        .filter((k) => /^e2eeKeys:\d+$/.test(k))
        .map((k) => ({
          key: k,
          keyId: Number(k.replace("e2eeKeys:", "")),
          value: data[k],
          parsed: parseStoredJsonRecord(data[k]),
        }))
        .filter(
          (entry) =>
            Number.isFinite(entry.keyId) &&
            typeof entry.parsed?.privKey === "string" &&
            entry.parsed.privKey.length > 0,
        )
        .sort((a, b) => b.keyId - a.keyId);

      if (selfMid && keyEntries.length > 0) {
        const newestKey = keyEntries[0]!;
        const selfKeyProp = `e2eeKeys:${selfMid}`;
        const currentSelfKey = parseStoredJsonRecord(data[selfKeyProp]);
        if (!currentSelfKey || String(currentSelfKey.keyId) !== String(newestKey.keyId)) {
          logger.info("line-bot-sync-e2ee-self-key", {
            oldKeyId: currentSelfKey?.keyId,
            newKeyId: newestKey.keyId,
          });
          await storage.set(selfKeyProp, newestKey.value);
        }
      }

      let clearedGroupKeys = 0;
      for (const k of Object.keys(data)) {
        if (k.startsWith("e2eeGroupKeys:")) {
          await storage.delete(k);
          clearedGroupKeys++;
        }
      }
      if (clearedGroupKeys > 0) {
        logger.info("line-bot-cleared-stale-group-keys", { count: clearedGroupKeys });
      }
      return;
    }

    if (!existsSync(storagePath)) return;
    const raw = await readFile(storagePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    const keyEntries = Object.keys(data)
      .filter((k) => /^e2eeKeys:\d+$/.test(k))
      .map((k) => ({
        key: k,
        keyId: Number(k.replace("e2eeKeys:", "")),
        value: data[k],
        parsed: parseStoredJsonRecord(data[k]),
      }))
      .filter(
        (entry) =>
          Number.isFinite(entry.keyId) &&
          typeof entry.parsed?.privKey === "string" &&
          entry.parsed.privKey.length > 0,
      )
      .sort((a, b) => b.keyId - a.keyId);

    let changed = false;

    if (selfMid && keyEntries.length > 0) {
      const newestKey = keyEntries[0]!;
      const selfKeyProp = `e2eeKeys:${selfMid}`;
      const currentSelfKey = parseStoredJsonRecord(data[selfKeyProp]);
      if (!currentSelfKey || String(currentSelfKey.keyId) !== String(newestKey.keyId)) {
        logger.info("line-bot-sync-e2ee-self-key", {
          oldKeyId: currentSelfKey?.keyId,
          newKeyId: newestKey.keyId,
        });
        data[selfKeyProp] = newestKey.value;
        changed = true;
      }
    }

    let clearedGroupKeys = 0;
    for (const k of Object.keys(data)) {
      if (k.startsWith("e2eeGroupKeys:")) {
        delete data[k];
        clearedGroupKeys++;
        changed = true;
      }
    }
    if (clearedGroupKeys > 0) {
      logger.info("line-bot-cleared-stale-group-keys", { count: clearedGroupKeys });
    }

    if (changed) {
      await writeFile(storagePath, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    logger.warn("line-bot-sync-e2ee-storage-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Harden @evex/linejs E2EE runtime on an authenticated client:
 *   1. Clamps newly generated Curve25519 group private keys in `tryRegisterE2EEGroupKey`
 *      and rejects RFC 7748 low-order / all-zero Curve25519 public keys across ECDH.
 *   2. Auto-rotates unclamped latest group keys before encrypting outgoing group messages,
 *      handles TalkServer deduplication without storage poisoning, and fetches exact
 *      historical group/peer keys (`getE2EEGroupSharedKey` / `getE2EEPublicKey`).
 *   3. Falls back to 256-bit unclamped X25519 when encrypting/decrypting V2 group messages
 *      under deduplicated legacy unclamped group keys.
 *   4. Guards `decryptE2EEMessage` so malformed/undecryptable messages log a warning
 *      instead of crashing `Client.listen()` with an unhandled rejection.
 */
export function installLineClientE2EEHardening(c: LineJsClient): void {
  const e2ee = c?.base?.e2ee;
  if (!e2ee || hardenedE2EEInstances.has(e2ee)) return;
  hardenedE2EEInstances.add(e2ee);

  const baseClient = c.base;
  const origTryRegister = e2ee.tryRegisterE2EEGroupKey.bind(e2ee);
  const origGetLocalPublicKey = e2ee.getE2EELocalPublicKey.bind(e2ee);
  const origEncryptMessage = e2ee.encryptE2EEMessage.bind(e2ee);
  const origEncryptUnbound = e2ee.encryptE2EEMessage;
  const origGenerateSharedSecret = e2ee.generateSharedSecret.bind(e2ee);
  const origDecryptV2 = e2ee.decryptE2EEMessageV2.bind(e2ee);
  const origDecryptMessage = e2ee.decryptE2EEMessage.bind(e2ee);
  const deduplicatedUnclampedKeys = new Set<string>();
  const historicalGroupKeyCache = new Map<string, { privKey: string; keyId: number }>();

  const rememberDeduplicatedUnclampedKey = (signature: string): void => {
    if (
      !deduplicatedUnclampedKeys.has(signature) &&
      deduplicatedUnclampedKeys.size >= MAX_DEDUPLICATED_UNCLAMPED_KEYS
    ) {
      const oldest = deduplicatedUnclampedKeys.values().next().value;
      if (oldest !== undefined) {
        deduplicatedUnclampedKeys.delete(oldest);
      }
    }
    deduplicatedUnclampedKeys.add(signature);
  };

  const rememberHistoricalGroupKey = (
    chatMid: string,
    record: { privKey: string; keyId: number },
  ): void => {
    const cacheKey = `${chatMid}:${record.keyId}`;
    if (historicalGroupKeyCache.has(cacheKey)) {
      historicalGroupKeyCache.delete(cacheKey);
    } else if (historicalGroupKeyCache.size >= MAX_HISTORICAL_GROUP_KEYS) {
      const oldest = historicalGroupKeyCache.keys().next().value;
      if (oldest !== undefined) {
        historicalGroupKeyCache.delete(oldest);
      }
    }
    historicalGroupKeyCache.set(cacheKey, record);
  };

  const safeGenerateSharedSecret = (privateKey: Buffer, publicKey: Buffer): Uint8Array => {
    const privBuf = toThriftBytes(privateKey);
    const pubBuf = toThriftBytes(publicKey);
    if (privBuf.byteLength !== 32 || pubBuf.byteLength !== 32) {
      throw new RangeError("Curve25519 ECDH requires 32-byte private and public keys");
    }
    const u = bytesToBigIntLE(pubBuf) & ((1n << 255n) - 1n);
    if (isLowOrderCurve25519U(u)) {
      throw new Error("Invalid X25519 public key: low-order point");
    }
    const secret = origGenerateSharedSecret(privBuf, pubBuf);
    const secretBuf = Buffer.from(secret);
    if (secretBuf.byteLength !== 32 || timingSafeEqual(secretBuf, ZERO_32_BYTES)) {
      throw new Error("Invalid X25519 public key: low-order point");
    }
    return secret;
  };
  e2ee.generateSharedSecret = safeGenerateSharedSecret;

  const decryptGroupSharedKey = async (
    sharedKey: LineJsGroupSharedKey,
  ): Promise<{ privKeyBuf: Buffer; record: { privKey: string; keyId: number } }> => {
    if (sharedKey.encryptedSharedKey === undefined) {
      throw new Error(`Missing encryptedSharedKey for groupKeyId=${sharedKey.groupKeyId}`);
    }
    const selfKeyData = await e2ee.getE2EESelfKeyDataByKeyId(sharedKey.receiverKeyId);
    if (!selfKeyData?.privKey) {
      throw new Error(`E2EE Key has not been saved for keyId=${sharedKey.receiverKeyId}`);
    }
    const selfPriv = Buffer.from(selfKeyData.privKey, "base64");
    const creatorPub = await e2ee.getE2EELocalPublicKey(sharedKey.creator, sharedKey.creatorKeyId);
    if (!Buffer.isBuffer(creatorPub)) {
      throw new Error("Expected creator E2EE public key buffer");
    }
    const secret = e2ee.generateSharedSecret(selfPriv, creatorPub);
    const aesKey = e2ee.getSHA256Sum(Buffer.from(secret), "Key");
    const aesIv = e2ee.xor(e2ee.getSHA256Sum(Buffer.from(secret), "IV"));
    const encryptedBuf = toThriftBytes(sharedKey.encryptedSharedKey);
    const decipher = createDecipheriv("aes-256-cbc", aesKey, aesIv);
    const plain = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
    return {
      privKeyBuf: plain,
      record: {
        privKey: plain.toString("base64"),
        keyId: sharedKey.groupKeyId,
      },
    };
  };

  e2ee.tryRegisterE2EEGroupKey = async (chatMid: string): Promise<LineJsGroupSharedKey> => {
    const selfMid = resolveClientSelfMid(c);
    if (
      !selfMid ||
      typeof baseClient.talk.getLastE2EEPublicKeys !== "function" ||
      typeof baseClient.talk.registerE2EEGroupKey !== "function"
    ) {
      return origTryRegister(chatMid);
    }

    const e2eePublicKeys = await baseClient.talk.getLastE2EEPublicKeys({ chatMid });
    const selfEntry = e2eePublicKeys[selfMid];
    if (!selfEntry) {
      return origTryRegister(chatMid);
    }
    const selfKeyData = await e2ee.getE2EESelfKeyDataByKeyId(selfEntry.keyId);
    if (!selfKeyData?.privKey) {
      throw new Error(
        "E2EE Key has not been saved, try register `saveE2EESelfKeyDataByKeyId` or use E2EE Login",
      );
    }

    const selfPriv = Buffer.from(selfKeyData.privKey, "base64");
    const clampedGroupPriv = clampCurve25519Scalar(randomBytes(32));
    const members: string[] = [];
    const keyIds: number[] = [];
    const encryptedSharedKeys: Buffer[] = [];

    for (const mid of Object.keys(e2eePublicKeys)) {
      const memberKey = e2eePublicKeys[mid]!;
      members.push(mid);
      keyIds.push(memberKey.keyId);
      const memberPubBuf = toThriftBytes(memberKey.keyData);
      if (baseClient.storage && memberPubBuf.byteLength === 32) {
        const existingPub = await baseClient.storage.get(`e2eePublicKeys:${memberKey.keyId}`);
        if (!existingPub) {
          await baseClient.storage.set(
            `e2eePublicKeys:${memberKey.keyId}`,
            memberPubBuf.toString("base64"),
          );
        }
      }
      const sharedSecret = e2ee.generateSharedSecret(selfPriv, memberPubBuf);
      const aesKey = e2ee.getSHA256Sum(Buffer.from(sharedSecret), "Key");
      const aesIv = e2ee.xor(e2ee.getSHA256Sum(Buffer.from(sharedSecret), "IV"));
      const cipher = createCipheriv("aes-256-cbc", aesKey, aesIv);
      encryptedSharedKeys.push(
        Buffer.concat([cipher.update(clampedGroupPriv), cipher.final()]),
      );
    }

    const registered = await baseClient.talk.registerE2EEGroupKey({
      keyVersion: 1,
      chatMid,
      keyIds,
      members,
      encryptedSharedKeys,
    });

    if (registered?.groupKeyId !== undefined && baseClient.storage) {
      let persistedRecord: { privKey: string; keyId: number } | null = null;
      if (registered.encryptedSharedKey !== undefined) {
        const decryptedRegistered = await decryptGroupSharedKey(registered);
        persistedRecord = decryptedRegistered.record;
      } else {
        // When TalkServer deduplicates registerE2EEGroupKey, encryptedSharedKey may be
        // omitted from the response struct while retaining the existing server groupKeyId.
        // Always prefer the authoritative server-stored shared key over the candidate key.
        let serverShared: LineJsGroupSharedKey | undefined;
        if (typeof baseClient.talk.getE2EEGroupSharedKey === "function") {
          try {
            serverShared = await baseClient.talk.getE2EEGroupSharedKey({
              keyVersion: 2,
              chatMid,
              groupKeyId: registered.groupKeyId,
            });
          } catch {
            serverShared = undefined;
          }
        }
        if (
          !serverShared?.encryptedSharedKey &&
          typeof baseClient.talk.getLastE2EEGroupSharedKey === "function"
        ) {
          try {
            const latest = await baseClient.talk.getLastE2EEGroupSharedKey({
              keyVersion: 2,
              chatMid,
            });
            if (latest?.groupKeyId === registered.groupKeyId) {
              serverShared = latest;
            }
          } catch {
            serverShared = undefined;
          }
        }
        if (serverShared?.encryptedSharedKey !== undefined) {
          const decryptedServer = await decryptGroupSharedKey(serverShared);
          persistedRecord = decryptedServer.record;
        } else {
          persistedRecord = {
            privKey: clampedGroupPriv.toString("base64"),
            keyId: registered.groupKeyId,
          };
        }
      }

      rememberHistoricalGroupKey(chatMid, persistedRecord);
      await baseClient.storage.set(`e2eeGroupKeys:${chatMid}`, JSON.stringify(persistedRecord));
    }

    logger.info("line-bot-e2ee-group-key-registered", {
      chatMid,
      groupKeyId: registered?.groupKeyId,
      memberCount: members.length,
    });

    return registered;
  };

  e2ee.getE2EELocalPublicKey = async (
    mid: string,
    keyId?: string | number,
  ): Promise<Buffer | { privKey: string; keyId: number }> => {
    const toType = baseClient.getToType?.(mid);
    const isUserMid = toType === 0 || (toType == null && mid.startsWith("u"));
    if (isUserMid) {
      try {
        const res = await origGetLocalPublicKey(mid, keyId);
        return Buffer.isBuffer(res) ? res : toThriftBytes(res);
      } catch (primaryUserKeyError) {
        if (keyId === undefined || typeof baseClient.talk.getE2EEPublicKey !== "function") {
          throw primaryUserKeyError;
        }
        const numericKeyId = Number(keyId);
        if (!Number.isFinite(numericKeyId)) {
          throw primaryUserKeyError;
        }
        const fetched = await baseClient.talk.getE2EEPublicKey({
          mid,
          keyVersion: 1,
          keyId: numericKeyId,
        });
        if (fetched?.keyData === undefined) {
          throw primaryUserKeyError;
        }
        const pubBuf = toThriftBytes(fetched.keyData);
        if (pubBuf.byteLength !== 32) {
          throw primaryUserKeyError;
        }
        if (baseClient.storage) {
          await baseClient.storage.set(`e2eePublicKeys:${numericKeyId}`, pubBuf.toString("base64"));
        }
        return pubBuf;
      }
    }

    if (!baseClient.storage || typeof baseClient.talk.getLastE2EEGroupSharedKey !== "function") {
      return origGetLocalPublicKey(mid, keyId);
    }

    const cachedRaw = await baseClient.storage.get(`e2eeGroupKeys:${mid}`);
    const cached = parseStoredJsonRecord(cachedRaw);
    const cachedKeyId = cached?.keyId !== undefined ? Number(cached.keyId) : undefined;
    const cachedPrivKey = typeof cached?.privKey === "string" ? cached.privKey : undefined;

    if (keyId !== undefined) {
      const targetKeyId = Number(keyId);
      if (cachedPrivKey && cachedKeyId === targetKeyId) {
        return { privKey: cachedPrivKey, keyId: targetKeyId };
      }

      const memCached = historicalGroupKeyCache.get(`${mid}:${targetKeyId}`);
      if (memCached) {
        return memCached;
      }

      const sharedKey =
        typeof baseClient.talk.getE2EEGroupSharedKey === "function"
          ? await baseClient.talk.getE2EEGroupSharedKey({
              keyVersion: 2,
              chatMid: mid,
              groupKeyId: targetKeyId,
            })
          : await baseClient.talk.getLastE2EEGroupSharedKey({
              keyVersion: 2,
              chatMid: mid,
            });
      const { record } = await decryptGroupSharedKey(sharedKey);
      rememberHistoricalGroupKey(mid, record);
      if (cachedKeyId === undefined || record.keyId >= cachedKeyId) {
        if (cachedKeyId !== record.keyId || cachedPrivKey !== record.privKey) {
          await baseClient.storage.set(`e2eeGroupKeys:${mid}`, JSON.stringify(record));
        }
      }
      return record;
    }

    let latestSharedKey: LineJsGroupSharedKey;
    try {
      latestSharedKey = await baseClient.talk.getLastE2EEGroupSharedKey({
        keyVersion: 2,
        chatMid: mid,
      });
    } catch (error) {
      const code = (error as { data?: { code?: string } } | undefined)?.data?.code;
      const msg = errorMessage(error);
      if (code === "NOT_FOUND" || msg.includes("NOT_FOUND")) {
        latestSharedKey = await e2ee.tryRegisterE2EEGroupKey(mid);
      } else {
        throw error;
      }
    }

    if (latestSharedKey.encryptedSharedKey === undefined) {
      const postRegisterCached = parseStoredJsonRecord(
        await baseClient.storage.get(`e2eeGroupKeys:${mid}`),
      );
      if (
        typeof postRegisterCached?.privKey === "string" &&
        postRegisterCached.keyId !== undefined
      ) {
        const recovered = {
          privKey: postRegisterCached.privKey,
          keyId: Number(postRegisterCached.keyId),
        };
        rememberHistoricalGroupKey(mid, recovered);
        return recovered;
      }
    }

    const cachedPrivBuf = cachedPrivKey ? Buffer.from(cachedPrivKey, "base64") : null;
    const { privKeyBuf, record } =
      cachedPrivKey &&
      cachedPrivBuf?.byteLength === 32 &&
      cachedKeyId === latestSharedKey.groupKeyId
        ? {
            privKeyBuf: cachedPrivBuf,
            record: { privKey: cachedPrivKey, keyId: cachedKeyId },
          }
        : await decryptGroupSharedKey(latestSharedKey);
    rememberHistoricalGroupKey(mid, record);
    const dedupSignature = `${mid}:${record.keyId}`;
    if (!isClampedCurve25519Scalar(privKeyBuf) && !deduplicatedUnclampedKeys.has(dedupSignature)) {
      logger.warn("line-bot-e2ee-rotating-unclamped-group-key", {
        chatMid: mid,
        oldGroupKeyId: record.keyId,
      });
      const rotated = await e2ee.tryRegisterE2EEGroupKey(mid);
      if (rotated?.groupKeyId === record.keyId) {
        rememberDeduplicatedUnclampedKey(dedupSignature);
        rememberHistoricalGroupKey(mid, record);
        await baseClient.storage.set(`e2eeGroupKeys:${mid}`, JSON.stringify(record));
        return record;
      }
      if (rotated?.encryptedSharedKey !== undefined) {
        const decryptedRotated = await decryptGroupSharedKey(rotated);
        rememberHistoricalGroupKey(mid, decryptedRotated.record);
        await baseClient.storage.set(
          `e2eeGroupKeys:${mid}`,
          JSON.stringify(decryptedRotated.record),
        );
        return decryptedRotated.record;
      }
      const postRotateCached = parseStoredJsonRecord(
        await baseClient.storage.get(`e2eeGroupKeys:${mid}`),
      );
      if (typeof postRotateCached?.privKey === "string" && postRotateCached.keyId !== undefined) {
        const resolvedRotated = {
          privKey: postRotateCached.privKey,
          keyId: Number(postRotateCached.keyId),
        };
        rememberHistoricalGroupKey(mid, resolvedRotated);
        return resolvedRotated;
      }
    }

    if (cachedKeyId !== record.keyId || cachedPrivKey !== record.privKey) {
      await baseClient.storage.set(`e2eeGroupKeys:${mid}`, JSON.stringify(record));
    }
    return record;
  };

  e2ee.encryptE2EEMessage = async (
    to: string,
    data: unknown,
    contentType?: unknown,
    specVersion?: number,
  ): Promise<Buffer[]> => {
    const toType = baseClient.getToType?.(to);
    const isUserMid = toType === 0 || (toType == null && to.startsWith("u"));
    if (isUserMid) {
      return origEncryptMessage(to, data, contentType, specVersion);
    }

    // For group/room messages, if LINE TalkServer deduplicated rotation and retained
    // a legacy unclamped group key, derive the group shared secret with full 256-bit
    // X25519 so Official LINE clients decrypt outgoing messages cleanly.
    const groupEncryptContext = Object.create(e2ee, {
      generateSharedSecret: {
        value: (privateKey: Buffer, publicKey: Buffer): Uint8Array =>
          isClampedCurve25519Scalar(privateKey)
            ? safeGenerateSharedSecret(privateKey, publicKey)
            : x25519Unclamped(privateKey, publicKey),
      },
    }) as LineJsE2EELike;

    return origEncryptUnbound.call(groupEncryptContext, to, data, contentType, specVersion);
  };

  e2ee.decryptE2EEMessageV2 = (
    to: string,
    from: string,
    chunks: Buffer[],
    privK: Buffer,
    pubK: Buffer,
    specVersion = 2,
    contentType: number | string = 0,
  ): Record<string, unknown> => {
    const normalizedContentType = normalizeE2EEContentType(contentType);
    try {
      return origDecryptV2(to, from, chunks, privK, pubK, specVersion, normalizedContentType);
    } catch (primaryError) {
      if (
        !Buffer.isBuffer(privK) ||
        privK.byteLength !== 32 ||
        isClampedCurve25519Scalar(privK) ||
        !Array.isArray(chunks) ||
        chunks.length < 5
      ) {
        throw primaryError;
      }

      try {
        const salt = toThriftBytes(chunks[0]);
        const message = toThriftBytes(chunks[1]);
        const nonce = toThriftBytes(chunks[2]);
        const senderKeyBytes = toThriftBytes(chunks[3]);
        const receiverKeyBytes = toThriftBytes(chunks[4]);
        const pubBuf = toThriftBytes(pubK);
        if (
          message.byteLength < 16 ||
          nonce.byteLength !== 12 ||
          pubBuf.byteLength !== 32 ||
          senderKeyBytes.byteLength === 0 ||
          receiverKeyBytes.byteLength === 0
        ) {
          throw primaryError;
        }
        const ciphertext = message.subarray(0, -16);
        const tag = message.subarray(-16);
        const senderKeyId = byte2intBE(senderKeyBytes);
        const receiverKeyId = byte2intBE(receiverKeyBytes);
        const unclampedSecret = x25519Unclamped(privK, pubBuf);
        const gcmKey = e2ee.getSHA256Sum(unclampedSecret, salt, "Key");
        const aad = e2ee.generateAAD(
          to,
          from,
          senderKeyId,
          receiverKeyId,
          specVersion,
          normalizedContentType,
        );
        const decipher = createDecipheriv("aes-256-gcm", gcmKey, nonce);
        decipher.setAuthTag(tag);
        decipher.setAAD(aad);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        logger.info("line-bot-e2ee-decrypted-unclamped-group-key", {
          to,
          receiverKeyId,
        });
        return JSON.parse(decrypted.toString("utf-8")) as Record<string, unknown>;
      } catch {
        throw primaryError;
      }
    }
  };

  e2ee.decryptE2EEMessage = async (
    messageObj: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      return await origDecryptMessage(messageObj);
    } catch (error) {
      logger.warn("line-bot-e2ee-message-decrypt-failed", {
        messageId: messageObj?.id,
        to: messageObj?.to,
        from: messageObj?.from,
        contentType: messageObj?.contentType,
        error: errorMessage(error),
      });
      return messageObj;
    }
  };
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
    if (decryptedToken)
      return { token: decryptedToken, device: parsed.device || env.LINEJS_TEST_DEVICE };
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
    try {
      await chmod(getAuthTokenPath(), 0o600);
    } catch {
      /* best effort on Windows */
    }
  } catch (error) {
    logger.warn("line-bot-auth-token-file-save-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
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
          const fileStorage = new FileStorage(storagePath) as LineJsStorageLike;
          const c = await linejs.loginWithAuthToken(storedToken.token, {
            device: storedToken.device,
            storage: fileStorage,
          });
          installLineClientE2EEHardening(c);
          await syncE2EEStorageKeys(
            storagePath,
            resolveClientSelfMid(c),
            c.base.storage ?? fileStorage,
          );
          client = c;
          attachImageListener(c);
          logger.info("line-bot-restored-from-token");
          return c;
        } catch (error) {
          logger.warn("line-bot-token-restore-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Fall back to QR login
      const fileStorage = new FileStorage(storagePath) as LineJsStorageLike;
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
          storage: fileStorage,
        },
      );

      currentQrUrl = "";
      currentPincode = "";
      installLineClientE2EEHardening(c);
      await saveAuthToken(c.authToken);
      await syncE2EEStorageKeys(
        storagePath,
        resolveClientSelfMid(c),
        c.base.storage ?? fileStorage,
      );
      client = c;
      attachImageListener(c);
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
      if (
        errMsg.includes("E2EE_UPDATE_SENDER_KEY") ||
        errMsg.includes("invalid sender key")
      ) {
        logger.warn("line-bot-e2ee-sender-key-outdated-retrying", { to, error: errMsg });
        await syncE2EEStorageKeys(getStoragePath(), resolveClientSelfMid(c), c.base.storage);
        try {
          await c.base.talk.sendMessage({ to, text, e2ee: true });
        } catch (retryError: unknown) {
          const retryErrMsg = retryError instanceof Error ? retryError.message : String(retryError);
          if (retryErrMsg.includes("E2EE_RETRY_PLAIN") || retryErrMsg.includes("E2EE Key has not been saved")) {
            logger.warn("line-bot-e2ee-fallback-plain", { to, error: retryErrMsg });
            await c.base.talk.sendMessage({ to, text, e2ee: false });
          } else {
            throw retryError;
          }
        }
      } else if (errMsg.includes("E2EE_RETRY_PLAIN") || errMsg.includes("E2EE Key has not been saved")) {
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
export async function getGroups(): Promise<{
  chats: Array<{ chatMid: string; chatName: string }>;
}> {
  if (!isLineBotEnabled()) {
    return { chats: [] };
  }

  try {
    const c = await getClient();
    const midsResult = await c.base.talk.getAllChatMids({
      syncReason: "INITIAL",
      request: { withMemberChats: true },
    });
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
    logger.error("line-bot-get-groups-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
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

export function isImageListenerActive(): boolean {
  return Boolean(imageListenerChatId && imageListenerClient);
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
    logger.warn("line-bot-get-profile-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
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
      hasE2EEKeys = keys.some(
        (k) => k.includes("e2ee") || k.includes("keyStore") || k.includes("e2eeKeyIds"),
      );
      // Auth state: qrCert, authToken, cert, etc.
      hasAuthState = keys.some(
        (k) =>
          k.includes("cert") || k.includes("auth") || k.includes("token") || k.includes("meta"),
      );
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

export function isLineImageReadTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timeout/i.test(message) ||
    /aborted/i.test(message)
  );
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
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
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

export async function bufferLineImageBlob(
  blob: Blob,
  maxBytes: number,
): Promise<{ buffer: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" }> {
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
    throw new Error(
      "Unsupported LINE image content. Supported image types are JPEG, PNG, and WebP.",
    );
  }
  if (declaredType && declaredType !== sniffedType) {
    throw new Error("LINE image MIME type does not match its content.");
  }

  return { buffer, mimeType: sniffedType };
}

const STATUS_COMMAND_COOLDOWN_MS = 3_000;
const lastStatusCommandReplyAt = new Map<string, number>();
const MAX_INCOMING_LINE_MESSAGE_AGE_MS = 5 * 60 * 1000;
const MAX_SEEN_LINE_MESSAGE_IDS = 2_000;
const processedLineMessageIds = new Set<string>();
let imageProcessingQueue: Promise<void> = Promise.resolve();

export function parseLineMessageTimestampMs(value: unknown): number | null {
  let num: number | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    num = value;
  } else if (typeof value === "bigint" && value > 0n) {
    num = Number(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    num = Number(value.trim());
  } else if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const converted = (value as { toNumber(): number }).toNumber();
    if (typeof converted === "number" && Number.isFinite(converted) && converted > 0) {
      num = converted;
    }
  }

  if (num === null || !Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num < 100_000_000_000 ? num * 1000 : num;
}

export function shouldIgnoreIncomingLineMessage(input: {
  messageId?: string;
  createdTime?: unknown;
  nowMs?: number;
  maxAgeMs?: number;
  seenMessageIds?: Set<string>;
}): { ignore: boolean; reason?: "duplicate_message_id" | "stale_message"; ageMs?: number } {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? MAX_INCOMING_LINE_MESSAGE_AGE_MS;
  const messageId = input.messageId?.trim() ?? "";

  if (messageId && input.seenMessageIds?.has(messageId)) {
    return { ignore: true, reason: "duplicate_message_id" };
  }

  const createdTimeMs = parseLineMessageTimestampMs(input.createdTime);
  if (createdTimeMs !== null) {
    const ageMs = nowMs - createdTimeMs;
    if (ageMs > maxAgeMs) {
      return { ignore: true, reason: "stale_message", ageMs };
    }
  }

  if (messageId && input.seenMessageIds) {
    if (input.seenMessageIds.size >= MAX_SEEN_LINE_MESSAGE_IDS) {
      const oldest = input.seenMessageIds.values().next().value;
      if (oldest !== undefined) {
        input.seenMessageIds.delete(oldest);
      }
    }
    input.seenMessageIds.add(messageId);
  }

  return { ignore: false };
}

async function replyToLineMessage(
  msg: { to?: { id: string }; from?: { id: string }; reply?: (text: string) => Promise<unknown> },
  text: string,
): Promise<boolean> {
  try {
    if (typeof msg.reply === "function") {
      await msg.reply(text);
      return true;
    }
  } catch (primaryError) {
    logger.warn("line-listener-primary-reply-failed", {
      to: msg.to?.id,
      error: primaryError instanceof Error ? primaryError.message : String(primaryError),
    });
  }

  // Fallback target: for group chats (c...), use msg.to.id; for 1-on-1 chats where to.id is bot (u...), use msg.from.id
  const fallbackTarget =
    msg.to?.id && !msg.to.id.startsWith("u") ? msg.to.id : msg.from?.id || msg.to?.id;

  if (fallbackTarget) {
    const fallback = await sendMessage(fallbackTarget, text);
    if (!fallback.ok) {
      logger.warn("line-listener-fallback-reply-failed", {
        to: fallbackTarget,
        error: fallback.error,
      });
      return false;
    }
    return true;
  }
  return false;
}

async function replyToLineImageMessage(msg: LineImageMessage, text: string): Promise<boolean> {
  return replyToLineMessage(msg, text);
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

function isLineImageMessage(msg: {
  raw?: { contentType?: string; text?: string };
  to?: { id: string; type: string };
  from?: { id: string };
  getData?(): Promise<Blob>;
  reply?(text: string): Promise<void>;
}): msg is LineImageMessage {
  return (
    msg.raw?.contentType === "IMAGE" &&
    typeof msg.getData === "function" &&
    typeof msg.reply === "function" &&
    Boolean(msg.to?.id) &&
    Boolean(msg.from?.id)
  );
}

/**
 * Attach the image-message handler to a specific client instance. Idempotent
 * per client and re-invoked after a logout/relogin rebuild so the OCR pipeline
 * keeps working. (The previous implementation set a permanent module flag that
 * logout() never reset, so the listener silently died after the first relogin.)
 */
function attachImageListener(c: LineJsClient): void {
  if (imageListenerClient === c) return;
  imageListenerClient = c;

  c.on("message", async (rawMessage: unknown) => {
    const msg = rawMessage as {
      text?: string;
      raw?: { id?: string; createdTime?: unknown; contentType?: string; text?: string };
      to?: { id: string; type: string };
      from?: { id: string };
      getData?(): Promise<Blob>;
      reply?(text: string): Promise<void>;
    };

    const toId = msg.to?.id;
    if (!toId) return;

    const messageCheck = shouldIgnoreIncomingLineMessage({
      messageId: msg.raw?.id,
      createdTime: msg.raw?.createdTime,
      nowMs: Date.now(),
      seenMessageIds: processedLineMessageIds,
    });
    if (messageCheck.ignore) {
      if (imageListenerChatId && toId === imageListenerChatId && msg.raw?.contentType === "IMAGE") {
        logger.info("line-image-listener-ignored-message", {
          to: toId,
          from: msg.from?.id,
          messageId: msg.raw?.id,
          reason: messageCheck.reason,
          ageMs: messageCheck.ageMs,
        });
      }
      return;
    }

    // Check for !status / !Status / !สถานะ commands from team groups
    const text = msg.text ?? msg.raw?.text;
    if (isLineStatusCommand(text)) {
      const now = Date.now();
      const lastReply = lastStatusCommandReplyAt.get(toId) ?? 0;
      if (now - lastReply < STATUS_COMMAND_COOLDOWN_MS) {
        return;
      }
      lastStatusCommandReplyAt.set(toId, now);
      if (lastStatusCommandReplyAt.size > 500) {
        lastStatusCommandReplyAt.clear();
      }

      logger.info("line-status-command-received", {
        to: toId,
        from: msg.from?.id,
        text,
      });
      try {
        const replyText = await handleLineStatusCommand({ chatId: toId });
        await replyToLineMessage(msg, replyText);
        logger.info("line-status-command-replied", { to: toId });
      } catch (cmdError) {
        logger.error("line-status-command-error", {
          to: toId,
          error: cmdError instanceof Error ? cmdError.message : String(cmdError),
        });
        await replyToLineMessage(msg, "⚠️ เกิดข้อผิดพลาดในการดึงสถานะบอท กรุณาลองใหม่อีกครั้ง");
      }
      return;
    }

    // Check for + / - route management commands from team groups
    if (isLineRouteCommand(text)) {
      const now = Date.now();
      const lastReply = lastStatusCommandReplyAt.get(toId) ?? 0;
      if (now - lastReply < STATUS_COMMAND_COOLDOWN_MS) {
        return;
      }
      lastStatusCommandReplyAt.set(toId, now);
      if (lastStatusCommandReplyAt.size > 500) {
        lastStatusCommandReplyAt.clear();
      }

      logger.info("line-route-command-received", {
        to: toId,
        from: msg.from?.id,
        text,
      });
      try {
        const replyText = await handleLineRouteCommand({
          chatId: toId,
          text: text!,
          senderId: msg.from?.id,
        });
        await replyToLineMessage(msg, replyText);
        logger.info("line-route-command-replied", { to: toId });
      } catch (cmdError) {
        logger.error("line-route-command-error", {
          to: toId,
          error: cmdError instanceof Error ? cmdError.message : String(cmdError),
        });
        await replyToLineMessage(msg, "⚠️ เกิดข้อผิดพลาดในการบันทึกเส้นทาง กรุณาลองใหม่อีกครั้ง");
      }
      return;
    }

    if (!imageListenerChatId || toId !== imageListenerChatId || !isLineImageMessage(msg)) return;

    imageProcessingQueue = imageProcessingQueue
      .then(async () => {
        let tempDir = "";
        const startedAt = Date.now();
        const timeoutMs = env.CODEX_IMAGE_TIMEOUT_MS;
        logger.info("line-image-listener-received", {
          to: msg.to?.id,
          from: msg.from?.id,
          messageId: (msg.raw as { id?: string } | undefined)?.id,
          contentType: msg.raw?.contentType,
          timeoutMs,
        });
        try {
          const blob = await msg.getData();
          const { buffer, mimeType } = await bufferLineImageBlob(blob, env.CODEX_IMAGE_MAX_BYTES);

          tempDir = await mkdtemp(join(tmpdir(), "spx-line-image-"));
          const imagePath = join(tempDir, `line-upload${extensionForLineImageMimeType(mimeType)}`);

          await pipeline(Readable.from(buffer), createWriteStream(imagePath, { flags: "wx" }));

          const ocrStartedAt = Date.now();
          logger.info("line-image-listener-ocr-start", {
            to: msg.to.id,
            bytes: buffer.byteLength,
            timeoutMs,
            remoteOcr: Boolean(env.OCR_SERVICE_URL.trim()),
          });
          const { processLineImage } = await import("./line-image-processor.js");
          const processed = await processLineImage({
            tempImagePath: imagePath,
            imageBuffer: buffer,
            mimeType,
            chatId: msg.to.id,
            senderId: msg.from.id,
            traceId: `${msg.to.id}:${startedAt}`,
            timeoutMs,
            model: env.CODEX_IMAGE_MODEL,
            ocrServiceUrl: env.OCR_SERVICE_URL,
            sharedSecret: resolveOutboundNodeSecret({
              nodeSecret: env.OCR_NODE_SECRET,
              legacySharedSecret: env.NOTIFIER_SHARED_SECRET,
              nodeEnv: env.NODE_ENV,
              deploymentMode: env.DEPLOYMENT_MODE,
            }).secret,
            nodeId: env.SPX_NODE_ID || "combined-line-service",
            ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
          });
          const read = processed.read;
          if (read.attempts > 1) {
            logger.info("line-image-listener-retried", {
              to: msg.to.id,
              attempts: read.attempts,
              ok: read.validation.ok,
              reason: read.validation.ok ? undefined : read.validation.reason,
            });
          }
          logger.info("line-image-listener-ocr-finished", {
            to: msg.to.id,
            durationMs: Date.now() - ocrStartedAt,
            textLength: read.text.length,
            attempts: read.attempts,
            remoteOcr: processed.usedRemoteOcr,
          });

          const replyDelivered = await replyToLineImageMessage(msg, processed.replyText);
          logger.info("line-image-listener-reply", {
            to: msg.to.id,
            savedToDb: processed.saved.saved,
            extractionId: processed.saved.id,
            reason: processed.saved.reason,
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
      })
      .catch((queueError) => {
        logger.warn("line-image-listener-queue-error", {
          error: queueError instanceof Error ? queueError.message : String(queueError),
        });
      });
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
