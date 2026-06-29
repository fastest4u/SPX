import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureInput {
  body: string;
  timestamp: string;
  nodeId: string;
  path: string;
  secret: string;
  eventKey?: string;
}

export interface VerifySignatureInput extends SignatureInput {
  signature: string;
  now?: Date;
  maxSkewMs?: number;
}

const hexSignaturePattern = /^[0-9a-f]{64}$/i;

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function validateNonEmptyString(value: unknown, reason: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, reason };
  return { ok: true, value };
}

export function createInternalSignature(input: SignatureInput): string {
  const body = requireNonEmptyString(input.body, "body");
  const timestamp = requireNonEmptyString(input.timestamp, "timestamp");
  const nodeId = requireNonEmptyString(input.nodeId, "nodeId");
  const path = requireNonEmptyString(input.path, "path");
  const secret = requireNonEmptyString(input.secret, "secret");
  const eventKey = input.eventKey === undefined ? undefined : requireNonEmptyString(input.eventKey, "eventKey");

  const payload = eventKey === undefined
    ? [timestamp, nodeId, path, body].join("\n")
    : [timestamp, nodeId, path, eventKey, body].join("\n");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyInternalSignature(input: VerifySignatureInput): { ok: boolean; reason?: string } {
  const body = validateNonEmptyString(input.body, "invalid_body");
  if (!body.ok) return body;
  const timestamp = validateNonEmptyString(input.timestamp, "invalid_timestamp");
  if (!timestamp.ok) return timestamp;
  const nodeId = validateNonEmptyString(input.nodeId, "invalid_node_id");
  if (!nodeId.ok) return nodeId;
  const path = validateNonEmptyString(input.path, "invalid_path");
  if (!path.ok) return path;
  const secret = validateNonEmptyString(input.secret, "invalid_secret");
  if (!secret.ok) return secret;
  const eventKey = input.eventKey === undefined ? undefined : validateNonEmptyString(input.eventKey, "invalid_event_key");
  if (eventKey !== undefined && !eventKey.ok) return eventKey;
  if (typeof input.signature !== "string" || !hexSignaturePattern.test(input.signature)) return { ok: false, reason: "invalid_signature" };

  const timestampMs = Date.parse(timestamp.value);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: "invalid_timestamp" };
  const nowMs = (input.now ?? new Date()).getTime();
  const maxSkewMs = input.maxSkewMs ?? 120_000;
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) return { ok: false, reason: "timestamp_out_of_range" };

  const expected = createInternalSignature({
    body: body.value,
    timestamp: timestamp.value,
    nodeId: nodeId.value,
    path: path.value,
    secret: secret.value,
    eventKey: eventKey?.value,
  });
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(input.signature, "hex");
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}
