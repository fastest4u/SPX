import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

export const STAGING_PHASE3_PRODUCTION_OBSERVER_POLICY_PATH =
  "/etc/spx-staging/phase3-production-observer-policy.json";
export const STAGING_PHASE3_PRODUCTION_OBSERVER_TOKEN_PATH =
  "/run/spx-staging-actions/phase3-production-observer-token";
export const STAGING_PHASE3_OBSERVER_PASSWORD_PATH =
  "/run/spx-staging-actions/database/principal-phase3-observer.password";

const SHA256 = /^[0-9a-f]{64}$/;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+={0,2}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function byteView(value, label, minimum, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeUtf8(value, label) {
  try {
    return UTF8.decode(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

export function validateStagingProductionObserverPolicyBytes(bytes, expectedSha256) {
  const label = "staging production observer policy";
  const value = byteView(bytes, label, 1, 8_192);
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    throw new Error(`${label} is invalid`);
  }
  const text = decodeUtf8(value, label);
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    policy === null ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).join(",") !== "endpoint,schemaVersion" ||
    typeof policy.endpoint !== "string" ||
    policy.schemaVersion !== 1 ||
    JSON.stringify({ endpoint: policy.endpoint, schemaVersion: 1 }) !== text
  ) {
    throw new Error(`${label} is invalid`);
  }
  let endpoint;
  try {
    endpoint = new URL(policy.endpoint);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    policy.endpoint !== policy.endpoint.trim() ||
    endpoint.protocol !== "https:" ||
    endpoint.hostname.length === 0 ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    policy.endpoint.includes("?") ||
    policy.endpoint.includes("#")
  ) {
    throw new Error(`${label} is invalid`);
  }
  const actual = createHash("sha256").update(value).digest();
  const expected = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw new Error(`${label} is invalid`);
  return true;
}

export function validateStagingProductionObserverTokenBytes(bytes) {
  const label = "staging production observer token";
  const value = byteView(bytes, label, 32, 4_096);
  const token = decodeUtf8(value, label);
  if (!BEARER_TOKEN.test(token)) throw new Error(`${label} is invalid`);
  return true;
}
