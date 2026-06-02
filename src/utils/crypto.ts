import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { logger } from "./logger.js";

/**
 * Symmetric AES-256-GCM encryption for secrets stored at rest (DB rows, files).
 *
 * Key derivation: SHA-256 of `SECRETS_KEY` env var, falling back to JWT_SECRET +
 * COOKIE_SECRET combined when SECRETS_KEY is not set so existing deployments
 * keep working without a manual key rotation step.
 *
 * Format: `enc:v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>`. Plain values
 * (no `enc:` prefix) are returned as-is from `decryptString` so legacy unencrypted
 * data continues to read until the next write encrypts it.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
    if (cachedKey) return cachedKey;
    const explicit = process.env.SECRETS_KEY?.trim();
    const fallback = `${process.env.JWT_SECRET ?? ""}::${process.env.COOKIE_SECRET ?? ""}`;
    const seed = explicit && explicit.length >= 16 ? explicit : fallback;
    if (!seed || seed === "::") {
        throw new Error(
            "Cannot derive secrets key: set SECRETS_KEY (>=16 chars) or both JWT_SECRET and COOKIE_SECRET",
        );
    }
    cachedKey = createHash("sha256").update(seed).digest();
    return cachedKey;
}

export function isEncrypted(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptString(plain: string): string {
    if (!plain) return "";
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, deriveKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptString(value: string | null | undefined): string {
    if (!value) return "";
    if (!isEncrypted(value)) return value;
    const [, , ivB64, tagB64, ctB64] = value.split(":");
    if (!ivB64 || !tagB64 || !ctB64) {
        logger.warn("decrypt-malformed-ciphertext");
        return "";
    }
    try {
        const iv = Buffer.from(ivB64, "base64");
        const tag = Buffer.from(tagB64, "base64");
        const ct = Buffer.from(ctB64, "base64");
        const decipher = createDecipheriv(ALGO, deriveKey(), iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
        return plaintext.toString("utf8");
    } catch {
        // An enc:-prefixed value failed to decrypt — most likely a SECRETS_KEY
        // rotation (or a changed JWT_SECRET/COOKIE_SECRET fallback) or tampering.
        // Surface a signal — never the value or key — instead of silently
        // returning an empty secret that looks indistinguishable from "unset".
        logger.warn("decrypt-failed", { reason: "auth-tag-or-key-mismatch" });
        return "";
    }
}
