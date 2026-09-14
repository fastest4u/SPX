import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  AutoAcceptPublicationRejectedError,
  type AutoAcceptAttemptKind,
  type AutoAcceptJobExecutionMode,
  type AutoAcceptJobRow,
} from "../repositories/auto-accept-job-repository.js";

export type AutoAcceptJobSource =
  | "pending_tab"
  | "non_pending_tab"
  | "booking_name"
  | "reconciliation";

export interface AutoAcceptJobRuleSnapshot {
  need: number;
  accept_all: boolean;
  enabled: boolean;
  fulfilled: boolean;
}

export interface SafeAutoAcceptJobTrip {
  request_id?: number;
  booking_id?: number;
  origin?: string;
  destination?: string;
  vehicle_type?: string;
  acceptance_status?: number;
  listAgeMs?: number;
}

export interface PublishAutoAcceptJobInput {
  /** Explicit admission; omitted callers publish observations only. */
  executionMode?: AutoAcceptJobExecutionMode;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  ruleName: string;
  attemptKind: AutoAcceptAttemptKind;
  acceptAll: boolean;
  source: AutoAcceptJobSource;
  trip?: Record<string, unknown> | null;
  ruleSnapshot: AutoAcceptJobRuleSnapshot;
  observedAt?: Date;
  firstMatchedAtMs?: number;
  pollerNodeId: string;
  cutoverEpoch?: string;
  pollerLeaseOwnerId?: string;
  bookingName?: string;
  bookingCreatedAtMs?: number;
  traceParent?: string;
}

export type PublishAutoAcceptJobResult =
  | { published: true; job: AutoAcceptJobRow }
  | {
      published: false;
      reason: "publication-fenced" | "stale-publication-epoch" | "admission-conflict";
    };

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstText(values: unknown[]): string | undefined {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return undefined;
}

export function sanitizeAutoAcceptJobTrip(
  trip: Record<string, unknown> | null | undefined,
  fallback: { bookingId: number; requestId: number }
): SafeAutoAcceptJobTrip | undefined {
  if (!trip) return undefined;

  const safe: SafeAutoAcceptJobTrip = {};
  const requestId = finiteNumber(trip.request_id) ?? fallback.requestId;
  const bookingId = finiteNumber(trip.booking_id) ?? fallback.bookingId;
  if (requestId > 0) safe.request_id = requestId;
  if (bookingId > 0) safe.booking_id = bookingId;

  const origin = firstText([trip.origin, trip["ต้นทาง"]]);
  const destination = firstText([trip.destination, trip["ปลายทาง"]]);
  const vehicleType = firstText([trip.vehicle_type, trip.vehicleType, trip["ประเภทรถ"]]);
  const acceptanceStatus = finiteNumber(trip.acceptance_status) ?? finiteNumber(trip.request_acceptance_status);
  const listAgeMs = finiteNumber(trip.listAgeMs);

  if (origin) safe.origin = origin;
  if (destination) safe.destination = destination;
  if (vehicleType) safe.vehicle_type = vehicleType;
  if (acceptanceStatus !== undefined) safe.acceptance_status = acceptanceStatus;
  if (listAgeMs !== undefined && listAgeMs >= 0) safe.listAgeMs = Math.floor(listAgeMs);

  return safe;
}

export async function publishAutoAcceptJob(
  input: PublishAutoAcceptJobInput,
): Promise<PublishAutoAcceptJobResult> {
  const identity = {
    executionMode: input.executionMode ?? "shadow",
    teamId: input.teamId,
    ...(input.cutoverEpoch ? { cutoverEpoch: input.cutoverEpoch } : {}),
    bookingId: input.bookingId,
    requestId: input.requestId,
    ruleId: input.ruleId,
    attemptKind: input.attemptKind,
  };
  const idempotencyKey = buildAutoAcceptJobIdempotencyKey(identity);
  const observedAt = input.observedAt ?? new Date();
  const trip = sanitizeAutoAcceptJobTrip(input.trip, {
    bookingId: input.bookingId,
    requestId: input.requestId,
  });

  try {
    const job = await enqueueAutoAcceptJob({
      ...identity,
      observedAt,
      payload: {
        executionMode: identity.executionMode,
        schemaVersion: 1,
        idempotencyKey,
        attemptKind: input.attemptKind,
        teamId: input.teamId,
        bookingId: input.bookingId,
        requestId: input.requestId,
        ruleId: input.ruleId,
        ruleName: input.ruleName,
        acceptAll: input.acceptAll,
        source: input.source,
        ...(trip ? { trip } : {}),
        ruleSnapshot: input.ruleSnapshot,
        observedAt: observedAt.toISOString(),
        ...(Number.isFinite(input.firstMatchedAtMs) && input.firstMatchedAtMs! >= 0
          ? { firstMatchedAtMs: input.firstMatchedAtMs } : {}),
        pollerNodeId: input.pollerNodeId,
        ...(input.cutoverEpoch ? { cutoverEpoch: input.cutoverEpoch } : {}),
        ...(input.pollerLeaseOwnerId ? { pollerLeaseOwnerId: input.pollerLeaseOwnerId } : {}),
        ...(input.bookingName ? { bookingName: input.bookingName } : {}),
        ...(input.bookingCreatedAtMs !== undefined ? { bookingCreatedAtMs: input.bookingCreatedAtMs } : {}),
        ...(input.traceParent ? { traceParent: input.traceParent } : {}),
      },
    });
    const durablePayload = JSON.parse(job.payloadJson) as { executionMode?: unknown };
    if (durablePayload.executionMode !== identity.executionMode) {
      return { published: false, reason: "admission-conflict" };
    }
    return { published: true, job };
  } catch (error) {
    if (error instanceof AutoAcceptPublicationRejectedError) {
      return { published: false, reason: error.reason };
    }
    throw error;
  }
}

export function publishAutoAcceptJobs(
  inputs: PublishAutoAcceptJobInput[],
): Promise<PublishAutoAcceptJobResult[]> {
  return Promise.all(inputs.map((input) => publishAutoAcceptJob(input)));
}
