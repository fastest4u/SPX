import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureInput {
  body: string;
  timestamp: string;
  nodeId: string;
  path: string;
  secret: string;
  eventKey?: string;
  requestId?: string;
  nodeEnvironment?: string;
}

export interface VerifySignatureInput extends SignatureInput {
  signature: string;
  now?: Date;
  maxSkewMs?: number;
}

export interface NodeSecretKeyRing {
  active: string;
  previous?: string;
  previousExpiresAt?: string;
}

export interface VerifyInternalNodeSignatureInput {
  body: string;
  timestamp: string;
  nodeId: string;
  path: string;
  signature: string;
  eventKey?: string;
  requestId?: string;
  nodeEnvironment?: string;
  nodeSecrets: ReadonlyMap<string, NodeSecretKeyRing>;
  now?: Date;
  maxSkewMs?: number;
  onKeyGeneration?: (generation: "active" | "previous") => void;
}

export interface InternalRequestReplayInput {
  nodeId: string;
  requestId: string;
  signedTimestamp: string;
  partition: string;
  now?: Date;
}

export type InternalRequestReplayResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "replay"
        | "capacity"
        | "invalid_request"
        | "invalid_timestamp"
        | "timestamp_out_of_range";
    };

export interface PreparedInternalRequestReplay {
  fingerprint: string;
  partition: string;
  now: Date;
  expiresAt: Date;
}

export interface InternalRequestReplayStore {
  consume(input: InternalRequestReplayInput): Promise<InternalRequestReplayResult>;
}

export interface InternalRequestReplayGuardOptions {
  maxSkewMs?: number;
  maxEntries?: number;
  maxEntriesPerPartition?: number;
}

export type PrepareInternalRequestReplayResult =
  | { ok: false; reason: "invalid_request" | "invalid_timestamp" | "timestamp_out_of_range" }
  | { ok: true; value: PreparedInternalRequestReplay };

const hexSignaturePattern = /^[0-9a-f]{64}$/i;
const defaultMaxSkewMs = 120_000;
const defaultReplayMaxEntries = 50_000;
const defaultReplayMaxEntriesPerPartition = 10_000;
const internalSignatureVersion = "spx-hmac-v2";
const allowedNodeEnvironments = new Set(["development", "test", "production"]);

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function validateNonEmptyString(value: unknown, reason: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, reason };
  return { ok: true, value };
}

function currentNodeEnvironment(): string {
  return process.env.NODE_ENV || "development";
}

function requireNodeEnvironment(value: unknown): string {
  const nodeEnvironment = requireNonEmptyString(value, "nodeEnvironment");
  if (!allowedNodeEnvironments.has(nodeEnvironment)) {
    throw new Error("nodeEnvironment must be development, test, or production");
  }
  return nodeEnvironment;
}

function validateNodeEnvironment(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  const nodeEnvironment = validateNonEmptyString(value, "invalid_node_environment");
  if (!nodeEnvironment.ok || !allowedNodeEnvironments.has(nodeEnvironment.value)) {
    return { ok: false, reason: "invalid_node_environment" };
  }
  return nodeEnvironment;
}

export function createInternalSignature(input: SignatureInput): string {
  const body = requireNonEmptyString(input.body, "body");
  const timestamp = requireNonEmptyString(input.timestamp, "timestamp");
  const nodeId = requireNonEmptyString(input.nodeId, "nodeId");
  const path = requireNonEmptyString(input.path, "path");
  const secret = requireNonEmptyString(input.secret, "secret");
  const eventKey = input.eventKey === undefined ? undefined : requireNonEmptyString(input.eventKey, "eventKey");
  const requestId = input.requestId === undefined ? undefined : requireNonEmptyString(input.requestId, "requestId");

  const prefix = requestId === undefined
    ? [timestamp, nodeId]
    : [
      internalSignatureVersion,
      timestamp,
      nodeId,
      requestId,
      requireNodeEnvironment(input.nodeEnvironment ?? currentNodeEnvironment()),
    ];
  const payload = eventKey === undefined
    ? [...prefix, path, body].join("\n")
    : [...prefix, path, eventKey, body].join("\n");
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
  const requestId = input.requestId === undefined ? undefined : validateNonEmptyString(input.requestId, "invalid_request_id");
  if (requestId !== undefined && !requestId.ok) return requestId;
  const nodeEnvironment = requestId === undefined
    ? undefined
    : validateNodeEnvironment(input.nodeEnvironment ?? currentNodeEnvironment());
  if (nodeEnvironment !== undefined && !nodeEnvironment.ok) return nodeEnvironment;
  if (typeof input.signature !== "string" || !hexSignaturePattern.test(input.signature)) return { ok: false, reason: "invalid_signature" };

  const timestampMs = Date.parse(timestamp.value);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: "invalid_timestamp" };
  const nowMs = (input.now ?? new Date()).getTime();
  const maxSkewMs = input.maxSkewMs ?? defaultMaxSkewMs;
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) return { ok: false, reason: "timestamp_out_of_range" };

  const expected = createInternalSignature({
    body: body.value,
    timestamp: timestamp.value,
    nodeId: nodeId.value,
    path: path.value,
    secret: secret.value,
    eventKey: eventKey?.value,
    requestId: requestId?.value,
    nodeEnvironment: nodeEnvironment?.value,
  });
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(input.signature, "hex");
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

function isPreviousKeyUsable(ring: NodeSecretKeyRing, nowMs: number): boolean {
  if (typeof ring.previous !== "string" || ring.previous.trim() === "") return false;
  if (ring.previousExpiresAt === undefined) return false;
  const expiresAtMs = Date.parse(ring.previousExpiresAt);
  return Number.isFinite(expiresAtMs) && nowMs < expiresAtMs;
}

export function verifyInternalNodeSignature(
  input: VerifyInternalNodeSignatureInput,
): { ok: boolean; reason?: string } {
  const body = validateNonEmptyString(input.body, "invalid_body");
  if (!body.ok) return body;
  const timestamp = validateNonEmptyString(input.timestamp, "invalid_timestamp");
  if (!timestamp.ok) return timestamp;
  const nodeId = validateNonEmptyString(input.nodeId, "invalid_node_id");
  if (!nodeId.ok) return nodeId;
  const path = validateNonEmptyString(input.path, "invalid_path");
  if (!path.ok) return path;
  const eventKey = input.eventKey === undefined ? undefined : validateNonEmptyString(input.eventKey, "invalid_event_key");
  if (eventKey !== undefined && !eventKey.ok) return eventKey;
  const requestId = input.requestId === undefined ? undefined : validateNonEmptyString(input.requestId, "invalid_request_id");
  if (requestId !== undefined && !requestId.ok) return requestId;
  const nodeEnvironment = requestId === undefined
    ? undefined
    : validateNodeEnvironment(input.nodeEnvironment ?? currentNodeEnvironment());
  if (nodeEnvironment !== undefined && !nodeEnvironment.ok) return nodeEnvironment;
  if (typeof input.signature !== "string" || !hexSignaturePattern.test(input.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const timestampMs = Date.parse(timestamp.value);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: "invalid_timestamp" };
  const nowMs = (input.now ?? new Date()).getTime();
  const maxSkewMs = input.maxSkewMs ?? defaultMaxSkewMs;
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const ring = input.nodeSecrets.get(nodeId.value);
  if (!ring || typeof ring.active !== "string" || ring.active.trim() === "") {
    return { ok: false, reason: "unknown_node" };
  }
  const base = {
    body: body.value,
    timestamp: timestamp.value,
    nodeId: nodeId.value,
    path: path.value,
    eventKey: eventKey?.value,
    requestId: requestId?.value,
    nodeEnvironment: nodeEnvironment?.value,
  };
  const actual = Buffer.from(input.signature, "hex");
  const expectedActive = createInternalSignature({ ...base, secret: ring.active });
  if (timingSafeEqual(Buffer.from(expectedActive, "hex"), actual)) {
    input.onKeyGeneration?.("active");
    return { ok: true };
  }
  if (isPreviousKeyUsable(ring, nowMs)) {
    const expectedPrevious = createInternalSignature({ ...base, secret: ring.previous as string });
    if (timingSafeEqual(Buffer.from(expectedPrevious, "hex"), actual)) {
      input.onKeyGeneration?.("previous");
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

function replayFingerprint(input: Pick<InternalRequestReplayInput, "partition" | "nodeId" | "requestId">): string {
  return createHash("sha256")
    .update([input.partition, input.nodeId, input.requestId].join("\n"), "utf8")
    .digest("hex");
}

export function prepareInternalRequestReplay(
  input: InternalRequestReplayInput,
  maxSkewMs: number,
): PrepareInternalRequestReplayResult {
  const nodeId = validateNonEmptyString(input.nodeId, "invalid_request");
  if (!nodeId.ok) return { ok: false, reason: "invalid_request" };
  const requestId = validateNonEmptyString(input.requestId, "invalid_request");
  if (!requestId.ok) return { ok: false, reason: "invalid_request" };
  const partition = validateNonEmptyString(input.partition, "invalid_request");
  if (!partition.ok) return { ok: false, reason: "invalid_request" };
  const signedTimestamp = validateNonEmptyString(input.signedTimestamp, "invalid_timestamp");
  if (!signedTimestamp.ok) return { ok: false, reason: "invalid_timestamp" };
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs <= 0) {
    return { ok: false, reason: "invalid_request" };
  }
  const timestampMs = Date.parse(signedTimestamp.value);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: "invalid_timestamp" };
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "invalid_request" };
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  return {
    ok: true,
    value: {
      fingerprint: replayFingerprint({
        partition: partition.value,
        nodeId: nodeId.value,
        requestId: requestId.value,
      }),
      partition: partition.value,
      now,
      expiresAt: new Date(nowMs + 2 * maxSkewMs),
    },
  };
}

class InMemoryInternalRequestReplayStore implements InternalRequestReplayStore {
  private readonly entries = new Map<string, { expiresAtMs: number; partition: string }>();

  constructor(
    private readonly maxEntries: number,
    private readonly maxEntriesPerPartition: number,
    private readonly maxSkewMs: number,
  ) {}

  async consume(input: InternalRequestReplayInput): Promise<InternalRequestReplayResult> {
    const prepared = prepareInternalRequestReplay(input, this.maxSkewMs);
    if (!prepared.ok) return prepared;
    const nowMs = prepared.value.now.getTime();
    for (const [fingerprint, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(fingerprint);
    }
    const existing = this.entries.get(prepared.value.fingerprint);
    if (existing !== undefined && existing.expiresAtMs > nowMs) {
      return { ok: false, reason: "replay" };
    }
    if (this.entries.size >= this.maxEntries) return { ok: false, reason: "capacity" };
    let partitionEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.partition === prepared.value.partition) partitionEntries += 1;
    }
    if (partitionEntries >= this.maxEntriesPerPartition) {
      return { ok: false, reason: "capacity" };
    }
    this.entries.set(prepared.value.fingerprint, {
      expiresAtMs: prepared.value.expiresAt.getTime(),
      partition: prepared.value.partition,
    });
    return { ok: true };
  }
}

export class InternalRequestReplayGuard implements InternalRequestReplayStore {
  private readonly maxSkewMs: number;
  private readonly store: InternalRequestReplayStore;

  constructor(options: InternalRequestReplayGuardOptions & { store?: InternalRequestReplayStore } = {}) {
    if (options.maxSkewMs !== undefined && (!Number.isSafeInteger(options.maxSkewMs) || options.maxSkewMs <= 0)) {
      throw new Error("replay guard skew is invalid");
    }
    this.maxSkewMs = options.maxSkewMs ?? defaultMaxSkewMs;
    const maxEntries = options.maxEntries ?? defaultReplayMaxEntries;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("replay guard capacity is invalid");
    }
    const maxEntriesPerPartition = options.maxEntriesPerPartition
      ?? Math.min(defaultReplayMaxEntriesPerPartition, maxEntries);
    if (
      !Number.isSafeInteger(maxEntriesPerPartition)
      || maxEntriesPerPartition <= 0
      || maxEntriesPerPartition > maxEntries
    ) {
      throw new Error("replay guard partition capacity is invalid");
    }
    this.store = options.store ?? new InMemoryInternalRequestReplayStore(
      maxEntries,
      maxEntriesPerPartition,
      this.maxSkewMs,
    );
  }

  async consume(input: InternalRequestReplayInput): Promise<InternalRequestReplayResult> {
    const prepared = prepareInternalRequestReplay(input, this.maxSkewMs);
    if (!prepared.ok) return prepared;
    try {
      return await this.store.consume(input);
    } catch {
      return { ok: false, reason: "capacity" };
    }
  }
}
