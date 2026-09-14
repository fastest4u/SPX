import { randomUUID } from "node:crypto";

export const REALTIME_ENVELOPE_VERSION = 1;

export const SUPPORTED_REALTIME_EVENT_TYPES = [
  "metrics.snapshot",
  "metrics.execution.snapshot",
  "metrics.aggregate",
  "rules.changed",
  "session.expired",
  "notification.queue.changed",
  "notification.delivery.changed",
  "ocr.changed",
  "runtime.node.changed",
  "runtime.lease.changed",
  "deploy.version.changed",
  "read-model.resync-required",
] as const;

export type RealtimeEventType = (typeof SUPPORTED_REALTIME_EVENT_TYPES)[number];

export const SUPPORTED_REALTIME_SOURCE_SERVICES = [
  "web-api",
  "worker",
  "poller-service",
  "auto-accept-service",
  "notifier",
  "notification-service",
  "line-service",
  "ocr-service",
  "realtime-service",
] as const;

export type RealtimeSourceService = (typeof SUPPORTED_REALTIME_SOURCE_SERVICES)[number];

export const SUPPORTED_REALTIME_PAYLOAD_VERSIONS = {
  "metrics.snapshot": [1],
  "metrics.execution.snapshot": [1],
  "metrics.aggregate": [1],
  "rules.changed": [1],
  "session.expired": [1],
  "notification.queue.changed": [1],
  "notification.delivery.changed": [1],
  "ocr.changed": [1],
  "runtime.node.changed": [1],
  "runtime.lease.changed": [1],
  "deploy.version.changed": [1],
  "read-model.resync-required": [1],
} as const satisfies Record<RealtimeEventType, readonly number[]>;

export type RealtimeScope =
  | { kind: "admin" }
  | { kind: "team"; teamId: number };

export interface RealtimeSubject {
  type: string;
  id: string;
  teamId?: number | null;
}

export interface RealtimeSource {
  service: RealtimeSourceService;
  nodeId: string;
  role: string;
}

export interface RealtimePublishInput<TPayload = unknown> {
  type: RealtimeEventType;
  payloadVersion: number;
  payload: TPayload;
  source: RealtimeSource;
  scope: RealtimeScope;
  subject?: RealtimeSubject;
  traceId?: string;
  emittedAt?: string;
  replayable?: boolean;
  idempotencyKey?: string;
}

export interface RealtimeEnvelopeInput<TPayload = unknown> extends RealtimePublishInput<TPayload> {
  id?: string;
  now?: Date;
}

export type RealtimeEnvelopeV1<TPayload = unknown> = Omit<RealtimePublishInput<TPayload>, "emittedAt" | "replayable"> & {
  envelopeVersion: typeof REALTIME_ENVELOPE_VERSION;
  id: string;
  emittedAt: string;
  receivedAt: string;
  replayable: boolean;
};

export interface RealtimePublishResult {
  accepted: boolean;
  duplicate: boolean;
  id: string;
  receivedAt: string;
  persisted: boolean;
}

export interface RealtimePublisher {
  publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult>;
  publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedRealtimeEventType(value: unknown): value is RealtimeEventType {
  return typeof value === "string" && SUPPORTED_REALTIME_EVENT_TYPES.includes(value as RealtimeEventType);
}

function isSupportedRealtimeSourceService(value: unknown): value is RealtimeSourceService {
  return typeof value === "string" && SUPPORTED_REALTIME_SOURCE_SERVICES.includes(value as RealtimeSourceService);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function assertValidTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
}

function assertValidDate(value: Date, fieldName: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}

function assertSupportedEventType(value: unknown): asserts value is RealtimeEventType {
  if (!isSupportedRealtimeEventType(value)) {
    throw new Error("Unsupported realtime event type");
  }
}

function assertSupportedPayloadVersion(type: RealtimeEventType, payloadVersion: unknown): asserts payloadVersion is number {
  if (
    !Number.isInteger(payloadVersion)
    || !SUPPORTED_REALTIME_PAYLOAD_VERSIONS[type].includes(payloadVersion as 1)
  ) {
    throw new Error("Unsupported realtime payload version");
  }
}

function assertValidSource(source: unknown): asserts source is RealtimeSource {
  if (!isRecord(source)) {
    throw new Error("source must be an object");
  }
  if (!isSupportedRealtimeSourceService(source.service)) {
    throw new Error("Unsupported realtime source service");
  }
  if (typeof source.nodeId !== "string" || source.nodeId.trim().length === 0) {
    throw new Error("source.nodeId must be non-empty");
  }
  if (typeof source.role !== "string" || source.role.trim().length === 0) {
    throw new Error("source.role must be non-empty");
  }
}

function assertValidScope(scope: unknown): asserts scope is RealtimeScope {
  if (!isRecord(scope)) {
    throw new Error("scope must be an object");
  }
  if (scope.kind === "admin") return;
  if (scope.kind === "team") {
    if (!isPositiveInteger(scope.teamId)) {
      throw new Error("scope.teamId must be a positive integer");
    }
    return;
  }
  throw new Error("Unsupported realtime scope kind");
}

function assertValidSubject(subject: unknown): asserts subject is RealtimeSubject {
  if (subject === undefined) return;
  if (!isRecord(subject)) {
    throw new Error("subject must be an object");
  }
  if (typeof subject.type !== "string" || subject.type.trim().length === 0) {
    throw new Error("subject.type must be non-empty");
  }
  if (typeof subject.id !== "string" || subject.id.trim().length === 0) {
    throw new Error("subject.id must be non-empty");
  }
  if (subject.teamId !== undefined && subject.teamId !== null && !isPositiveInteger(subject.teamId)) {
    throw new Error("subject.teamId must be a positive integer");
  }
}

function assertReplayableFields(replayable: unknown, idempotencyKey: unknown): void {
  if (replayable === true && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0)) {
    throw new Error("idempotencyKey is required for replayable events");
  }
}

export function createRealtimeEnvelope<TPayload>(
  input: RealtimeEnvelopeInput<TPayload>,
): RealtimeEnvelopeV1<TPayload> {
  assertSupportedEventType(input.type);
  assertSupportedPayloadVersion(input.type, input.payloadVersion);
  assertValidSource(input.source);
  assertValidScope(input.scope);
  assertValidSubject(input.subject);
  assertReplayableFields(input.replayable, input.idempotencyKey);

  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const receivedAt = now.toISOString();
  const emittedAt = input.emittedAt ?? receivedAt;
  assertValidTimestamp(emittedAt, "emittedAt");

  if (input.id !== undefined && input.id.trim().length === 0) {
    throw new Error("id must be non-empty");
  }

  return {
    envelopeVersion: REALTIME_ENVELOPE_VERSION,
    id: input.id ?? `${input.type}:${randomUUID()}`,
    type: input.type,
    payloadVersion: input.payloadVersion,
    payload: input.payload,
    source: input.source,
    scope: input.scope,
    subject: input.subject,
    traceId: input.traceId,
    emittedAt,
    receivedAt,
    replayable: input.replayable ?? false,
    idempotencyKey: input.idempotencyKey,
  };
}

export function assertSupportedRealtimeEnvelope(value: unknown): asserts value is RealtimeEnvelopeV1<unknown> {
  if (!isRecord(value)) {
    throw new Error("Realtime envelope must be an object");
  }
  if (value.envelopeVersion !== REALTIME_ENVELOPE_VERSION) {
    throw new Error("Unsupported realtime envelope version");
  }
  assertSupportedEventType(value.type);
  assertSupportedPayloadVersion(value.type, value.payloadVersion);
  assertValidSource(value.source);
  assertValidScope(value.scope);
  assertValidSubject(value.subject);
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("id must be non-empty");
  }
  if (typeof value.emittedAt !== "string") {
    throw new Error("emittedAt must be an ISO timestamp");
  }
  assertValidTimestamp(value.emittedAt, "emittedAt");
  if (typeof value.receivedAt !== "string") {
    throw new Error("receivedAt must be an ISO timestamp");
  }
  assertValidTimestamp(value.receivedAt, "receivedAt");
  if (typeof value.replayable !== "boolean") {
    throw new Error("replayable must be a boolean");
  }
  assertReplayableFields(value.replayable, value.idempotencyKey);
}

export interface SerializeSseEnvelopeOptions {
  resetLastEventId?: boolean;
}

export function serializeSseEnvelope(
  envelope: RealtimeEnvelopeV1<unknown>,
  options: SerializeSseEnvelopeOptions = {},
): string {
  assertSupportedRealtimeEnvelope(envelope);
  const id = options.resetLastEventId ? "id:" : `id: ${envelope.id}`;
  return `${id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
