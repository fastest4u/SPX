import { metrics, type MetricsCollector } from "./metrics.js";
import type { ApiClient } from "./api-client.js";
import { rejectUnadmittedAutoAcceptJob } from "./auto-accept-job-admission.js";
import {
  buildAutoAcceptTraceId,
} from "./auto-accept-diagnostics.js";
import {
  validateAutoAcceptJobDryRunPayloadStructure,
  validateAutoAcceptJobDryRunRuleState,
  type AutoAcceptDryRunPayloadV1,
  type AutoAcceptDryRunRuleStateLoader,
  type AutoAcceptDryRunValidationResult,
} from "./auto-accept-job-dry-run.js";
import {
  verifyAutoAcceptJob,
  type AutoAcceptVerifiedRequest,
  type AutoAcceptVerificationJob,
} from "./auto-accept-verifier.js";
import {
  runAutoAcceptWorkerBatch,
  type AutoAcceptJobExecutionContext,
  type AutoAcceptJobExecutionResult,
  type AutoAcceptJobExecutor,
  type AutoAcceptWorkerBatchResult,
  type RunAutoAcceptWorkerBatchInput,
} from "./auto-accept-worker.js";
import type { TripLike } from "./notify-rules.js";
import {
  buildAutoAcceptJobIdempotencyKey,
  enqueueAutoAcceptJob,
  type AutoAcceptAttemptKind,
  type AutoAcceptJobResultStatus,
} from "../repositories/auto-accept-job-repository.js";
import { assertJobPublicationCurrent } from "../repositories/auto-accept-publication-control-repository.js";
import {
  beginAutoAcceptAttempt,
  completeAutoAcceptAttempt,
  getAutoAcceptResult,
  getAutoAcceptAttemptByTraceId,
  listOwnedAutoAcceptResultsByWinningTrace,
  upsertAutoAcceptResult,
  type AutoAcceptAttemptRow,
  type AutoAcceptResultRow,
  type AutoAcceptResultStatus,
} from "../repositories/auto-accept-result-repository.js";
import {
  listStaleAutoAcceptRuleBudgetReservations,
  releaseAutoAcceptRuleBudgetOnce,
  reserveAutoAcceptRuleBudgetOnce,
  type AutoAcceptStaleBudgetReservationCandidate,
} from "../repositories/auto-accept-job-settlement-repository.js";
import type { BookingRequestListData } from "../models/types.js";
import { extractAllRequestListTrips } from "../utils/booking-extractor.js";

type FastAcceptAllRequestListItem = BookingRequestListData["request_list"][number] | Record<string, unknown>;

export interface AutoAcceptJobRealExecutionApi {
  acceptBookingRequests(
    bookingId: number,
    requestIds: number[],
  ): Promise<{ ok: boolean; httpStatus: number; response: { retcode?: number; message?: string } | null; error?: string }>;
  acceptAllBookingRequests?(
    bookingId: number,
  ): Promise<{ ok: boolean; httpStatus: number; response: { retcode?: number; message?: string; data?: unknown } | null; error?: string }>;
  fetchBookingRequestList(
    bookingId: number,
    options?: { tabPendingConfirmation?: boolean },
  ): Promise<{ data: { request_list: FastAcceptAllRequestListItem[] } } | null>;
}

export interface AutoAcceptJobRealExecutionOptions {
  metricsCollector?: MetricsCollector;
  apiClient: AutoAcceptJobRealExecutionApi;
  loadRuleState: AutoAcceptDryRunRuleStateLoader;
  canStartNewExternalAttempt?: AutoAcceptJobNewExternalAttemptPolicy;
  ambiguousRecheckDelayMs?: number;
  retryDelayMsOnRuleStateError?: number;
  retryDelayMsOnSettlementPending?: number;
  retryDelayMsOnCheckpointError?: number;
  staleBudgetReservationTtlMs?: number;
  staleBudgetReservationLimit?: number;
  enqueueFastAcceptAllChildJob?: typeof enqueueAutoAcceptJob;
  afterFastAcceptAllCanonicalResult?: (input: {
    traceId: string;
    requestId: number;
  }) => Promise<void>;
}

export interface AutoAcceptJobNewExternalAttemptPolicyInput {
  jobId: number;
  teamId: number;
  attemptKind: AutoAcceptAttemptKind;
}

export type AutoAcceptJobNewExternalAttemptPolicy = (
  input: AutoAcceptJobNewExternalAttemptPolicyInput,
) => boolean | Promise<boolean>;

export interface RunAutoAcceptJobRealExecutionBatchInput
  extends Omit<RunAutoAcceptWorkerBatchInput, "execute">,
    AutoAcceptJobRealExecutionOptions {}

type CanonicalRequestResult = {
  status: AutoAcceptResultStatus;
  reasonCode: string;
};

type FastAcceptAllObservedTrip = {
  requestId: number;
  acceptanceStatus: number | null;
  trip: Record<string, unknown>;
};

const DEFAULT_RULE_STATE_RETRY_DELAY_MS = 30_000;
const DEFAULT_SETTLEMENT_PENDING_RETRY_DELAY_MS = 1;
const DEFAULT_CHECKPOINT_RETRY_DELAY_MS = 30_000;
const DEFAULT_STALE_BUDGET_RESERVATION_TTL_MS = 15 * 60_000;
const DEFAULT_STALE_BUDGET_RESERVATION_LIMIT = 3;
const ATTEMPT_IDENTITY_CONFLICT = "auto_accept_attempt_identity_conflict";

type DryRunValidationFailure = Extract<AutoAcceptDryRunValidationResult, { ok: false }>;

type ExternalAttemptResolution =
  | { kind: "new"; traceId: string }
  | { kind: "existing"; traceId: string; row: AutoAcceptAttemptRow }
  | { kind: "retry"; execution: AutoAcceptJobExecutionResult }
  | { kind: "conflict"; execution: AutoAcceptJobExecutionResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retry(input: {
  reasonCode: string;
  retryDelayMs: number;
  error?: string | null;
}): AutoAcceptJobExecutionResult {
  return {
    outcome: "retry",
    reasonCode: input.reasonCode,
    error: input.error,
    retryDelayMs: input.retryDelayMs,
    count: "verify",
  };
}

async function enforceCurrentPublication(
  context: AutoAcceptJobExecutionContext,
  options: AutoAcceptJobRealExecutionOptions,
): Promise<AutoAcceptJobExecutionResult | null> {
  try {
    await assertJobPublicationCurrent(context.row);
    return null;
  } catch (error) {
    if (errorMessage(error) === "stale publication epoch") {
      return {
        outcome: "indeterminate",
        resultStatus: "unknown",
        reasonCode: "stale_publication_epoch",
      };
    }
    return retry({
      reasonCode: "publication_control_unavailable",
      error: "publication control could not be read",
      retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
    });
  }
}

async function applyNewExternalAttemptPolicy(
  context: AutoAcceptJobExecutionContext,
  payload: AutoAcceptDryRunPayloadV1,
  options: AutoAcceptJobRealExecutionOptions,
): Promise<AutoAcceptJobExecutionResult | null> {
  // Keep this before marker creation: once a marker exists, recovery must assume the POST may have happened.
  if (!options.canStartNewExternalAttempt) return null;

  let allowed: boolean;
  try {
    allowed = await options.canStartNewExternalAttempt({
      jobId: context.row.id,
      teamId: payload.teamId,
      attemptKind: payload.attemptKind,
    });
  } catch {
    return retry({
      reasonCode: "real_execution_policy_unavailable",
      error: "new external attempt policy could not be read",
      retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
    });
  }

  if (allowed) return null;
  return retry({
    reasonCode: "real_execution_policy_blocked",
    error: "new external attempt is blocked by runtime policy",
    retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
  });
}

function validationFailureExecution(
  validation: DryRunValidationFailure,
  options: AutoAcceptJobRealExecutionOptions,
): AutoAcceptJobExecutionResult {
  if (validation.retryable) {
    return retry({
      reasonCode: validation.reasonCode,
      error: validation.error,
      retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
    });
  }
  return {
    outcome: "dead_letter",
    reasonCode: validation.reasonCode,
    error: validation.error,
  };
}

function externalAttemptRetry(
  reasonCode: string,
  retryDelayMs: number,
  error: string,
): AutoAcceptJobExecutionResult {
  return retry({ reasonCode, retryDelayMs, error });
}

function externalAttemptConflict(reasonCode: string, error: string): AutoAcceptJobExecutionResult {
  return { outcome: "dead_letter", reasonCode, error };
}

function isAttemptIdentityConflict(error: unknown): boolean {
  return error instanceof Error && error.message === ATTEMPT_IDENTITY_CONFLICT;
}

function requestAttemptTraceId(jobId: number, ordinal: number): string {
  return `aa-job:${jobId}:external:${ordinal}`;
}

function externalAttemptBeginInput(input: {
  context: AutoAcceptJobExecutionContext;
  payload: AutoAcceptDryRunPayloadV1;
  traceId: string;
  acceptStartedAt: Date;
  acceptMode: "request_ids" | "accept_all";
}) {
  const base = {
    traceId: input.traceId,
    teamId: input.payload.teamId,
    workerNodeId: input.context.ownerNodeId,
    bookingId: input.payload.bookingId,
    ruleId: input.payload.ruleId,
    ruleName: input.payload.ruleName,
    acceptStartedAt: input.acceptStartedAt,
  };
  return input.acceptMode === "accept_all"
    ? { ...base, acceptMode: "accept_all" as const, requestIds: [] }
    : { ...base, acceptMode: "request_ids" as const, requestIds: [input.payload.requestId] };
}

async function resolveExternalAttempt(
  context: AutoAcceptJobExecutionContext,
  payload: AutoAcceptDryRunPayloadV1,
  retryDelayMs: number,
  acceptMode: "request_ids" | "accept_all",
): Promise<ExternalAttemptResolution> {
  const candidate = Math.max(1, context.row.attemptCount + 1);
  const found: Array<{ traceId: string; row: AutoAcceptAttemptRow }> = [];
  try {
    for (let ordinal = 1; ordinal <= candidate; ordinal++) {
      const traceId = requestAttemptTraceId(context.row.id, ordinal);
      const row = await getAutoAcceptAttemptByTraceId(traceId);
      if (row) found.push({ traceId, row });
    }
  } catch {
    return {
      kind: "retry",
      execution: externalAttemptRetry(
        "external_attempt_lookup_failed",
        retryDelayMs,
        "external attempt marker lookup failed",
      ),
    };
  }

  if (found.length > 1) {
    return {
      kind: "conflict",
      execution: externalAttemptConflict(
        "external_attempt_trace_conflict",
        "multiple external attempt markers exist for one job",
      ),
    };
  }
  if (found.length === 0) {
    return { kind: "new", traceId: requestAttemptTraceId(context.row.id, candidate) };
  }

  const existing = found[0];
  try {
    const validated = await beginAutoAcceptAttempt(externalAttemptBeginInput({
      context,
      payload,
      traceId: existing.traceId,
      acceptStartedAt: context.currentTime(),
      acceptMode,
    }));
    return { kind: "existing", traceId: existing.traceId, row: validated.row };
  } catch (error) {
    if (isAttemptIdentityConflict(error)) {
      return {
        kind: "retry",
        execution: externalAttemptRetry(
          "external_attempt_identity_conflict",
          retryDelayMs,
          "external attempt identity conflict",
        ),
      };
    }
    return {
      kind: "retry",
      execution: externalAttemptRetry(
        "external_attempt_validation_failed",
        retryDelayMs,
        "external attempt marker validation failed",
      ),
    };
  }
}

function canonicalResultForVerifiedRequest(request: AutoAcceptVerifiedRequest | undefined): CanonicalRequestResult {
  if (!request) {
    return {
      status: "unknown",
      reasonCode: "verify_indeterminate",
    };
  }

  if (request.status === "accepted") {
    return {
      status: "owned",
      reasonCode: "verified_owned",
    };
  }

  if (request.status === "indeterminate") {
    return {
      status: "unknown",
      reasonCode: request.reason === "accept_timeout_ambiguous" ? "accept_timeout_ambiguous" : "verify_indeterminate",
    };
  }

  if (request.reason === "lost_race") {
    return {
      status: "lost",
      reasonCode: "verified_lost_race",
    };
  }

  if (request.reason === "verify_not_confirmed") {
    return {
      status: "lost",
      reasonCode: "verified_not_owned",
    };
  }

  if (request.reason === "session_expired") {
    return {
      status: "failed",
      reasonCode: "session_expired",
    };
  }

  return {
    status: "failed",
    reasonCode: "accept_api_error",
  };
}

function staleBudgetReservationLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_STALE_BUDGET_RESERVATION_LIMIT;
}

function staleBudgetReservationTtlMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_STALE_BUDGET_RESERVATION_TTL_MS;
}

function parseStaleReservationPayload(candidate: AutoAcceptStaleBudgetReservationCandidate): AutoAcceptDryRunPayloadV1 | null {
  try {
    const parsed = JSON.parse(candidate.payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1) return null;
    if (record.attemptKind !== "pending_request") return null;
    if (typeof record.teamId !== "number" || record.teamId !== candidate.teamId) return null;
    if (typeof record.bookingId !== "number" || record.bookingId !== candidate.bookingId) return null;
    if (typeof record.requestId !== "number" || record.requestId !== candidate.requestId) return null;
    if (typeof record.ruleId !== "string" || record.ruleId !== candidate.ruleId) return null;
    if (typeof record.ruleName !== "string" || !record.ruleName.trim()) return null;
    if (record.acceptAll !== false) return null;
    if (record.source !== "pending_tab") return null;
    if (!record.trip || typeof record.trip !== "object" || Array.isArray(record.trip)) return null;
    if (!record.ruleSnapshot || typeof record.ruleSnapshot !== "object" || Array.isArray(record.ruleSnapshot)) return null;
    if (typeof record.observedAt !== "string" || !record.observedAt.trim()) return null;
    if (typeof record.pollerNodeId !== "string" || !record.pollerNodeId.trim()) return null;
    return record as unknown as AutoAcceptDryRunPayloadV1;
  } catch {
    return null;
  }
}

async function reconcileStaleBudgetReservations(input: {
  payload: AutoAcceptDryRunPayloadV1;
  apiClient: AutoAcceptJobRealExecutionApi;
  now: Date;
  ttlMs?: number;
  limit?: number;
}): Promise<void> {
  const ttlMs = staleBudgetReservationTtlMs(input.ttlMs);
  const candidates = await listStaleAutoAcceptRuleBudgetReservations({
    teamId: input.payload.teamId,
    ruleId: input.payload.ruleId,
    staleBefore: new Date(input.now.getTime() - ttlMs),
    limit: staleBudgetReservationLimit(input.limit),
  });

  for (const candidate of candidates) {
    const stalePayload = parseStaleReservationPayload(candidate);
    if (!stalePayload || stalePayload.attemptKind !== "pending_request") continue;
    const staleTrip = stalePayload.trip;
    if (!staleTrip) continue;

    const traceId = candidate.winningAttemptTraceId ?? `stale-budget-reconcile:${candidate.jobId}`;
    const verification = await verifyAutoAcceptJob(
      input.apiClient as unknown as ApiClient,
      {
        teamId: stalePayload.teamId,
        ruleId: stalePayload.ruleId,
        ruleName: stalePayload.ruleName,
        bookingId: stalePayload.bookingId,
        requestIds: [stalePayload.requestId],
        trips: [staleTrip as TripLike],
        claimToken: 0,
        acceptResult: {
          ok: true,
          httpStatus: 200,
        },
        acceptStartedAt: input.now.getTime(),
        acceptFinishedAt: input.now.getTime(),
        acceptRttMs: 0,
        listAgeMs: typeof staleTrip.listAgeMs === "number" ? staleTrip.listAgeMs : undefined,
        ambiguousAccept: false,
        acceptAll: false,
        traceId,
      },
      { ambiguousRecheckDelayMs: 0 },
    );
    const request = verification.requests.find((item) => item.requestId === stalePayload.requestId);
    if (!verification.evidence.pendingTabRead || !verification.evidence.confirmedTabRead) continue;
    if (!request || request.status !== "failed") continue;

    await releaseAutoAcceptRuleBudgetOnce({
      jobId: candidate.jobId,
      teamId: stalePayload.teamId,
      bookingId: stalePayload.bookingId,
      requestIds: [stalePayload.requestId],
      ruleId: stalePayload.ruleId,
      acceptedCount: 1,
      traceId,
      reasonCode: request.reason ?? "stale_budget_reconcile_not_owned",
      now: input.now,
    });
  }
}

function shouldReleaseBudgetReservation(status: string | null | undefined): boolean {
  return status === "lost" || status === "failed";
}

function tripListFor(payload: AutoAcceptDryRunPayloadV1): TripLike[] {
  return payload.trip ? [payload.trip as TripLike] : [];
}

function listAgeMsFor(payload: AutoAcceptDryRunPayloadV1): number | undefined {
  const value = payload.trip?.listAgeMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function observedAcceptanceStatus(payload: AutoAcceptDryRunPayloadV1): number | null {
  const value = payload.trip?.acceptance_status ?? payload.trip?.request_acceptance_status;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeFastAcceptAllTrip(
  item: FastAcceptAllRequestListItem,
  payload: AutoAcceptDryRunPayloadV1,
): FastAcceptAllObservedTrip | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const itemRecord = item as unknown as Record<string, unknown>;
  const requestIdValue = numericValue(itemRecord.request_id);
  if (typeof requestIdValue !== "number" || !Number.isInteger(requestIdValue) || requestIdValue <= 0) return null;
  const requestId = requestIdValue;

  const bookingId = numericValue(itemRecord.booking_id);
  if (bookingId === null || !Number.isInteger(bookingId) || bookingId !== payload.bookingId) return null;
  const status = numericValue(itemRecord.request_acceptance_status) ?? numericValue(itemRecord.acceptance_status);
  if (status === null || !Number.isInteger(status) || status < 0) return null;
  const [extractedTrip] = extractAllRequestListTrips({
    pageno: 1,
    count: 1,
    total: 1,
    request_list: [item as unknown as BookingRequestListData["request_list"][number]],
  }, {
    booking_id: payload.bookingId,
    booking_name: payload.bookingName ?? textValue(itemRecord.booking_name) ?? payload.ruleName,
    agency_name: textValue(itemRecord.agency_name) ?? textValue(itemRecord.agencyName) ?? "",
    listAgeMs: numericValue(itemRecord.listAgeMs) ?? numericValue(payload.trip?.listAgeMs) ?? undefined,
  });
  const trip: Record<string, unknown> = {
    request_id: requestId,
    booking_id: payload.bookingId,
  };
  const origin = textValue(extractedTrip?.["ต้นทาง"]) ?? textValue(itemRecord.origin) ?? textValue(itemRecord["ต้นทาง"]) ?? textValue(payload.trip?.origin);
  const destination = textValue(extractedTrip?.["ปลายทาง"]) ?? textValue(itemRecord.destination) ?? textValue(itemRecord["ปลายทาง"]) ?? textValue(payload.trip?.destination);
  const vehicleType = textValue(extractedTrip?.["ประเภทรถ"]) ?? textValue(itemRecord.vehicle_type) ?? textValue(itemRecord.vehicleType) ?? textValue(itemRecord["ประเภทรถ"]);
  if (origin) trip.origin = origin;
  if (destination) trip.destination = destination;
  if (vehicleType) trip.vehicle_type = vehicleType;
  if (status !== null) trip.acceptance_status = status;
  if (extractedTrip) {
    trip.booking_id = extractedTrip.booking_id ?? payload.bookingId;
    if (extractedTrip.booking_name) trip.booking_name = extractedTrip.booking_name;
    if (extractedTrip.agency_name) trip.agency_name = extractedTrip.agency_name;
    trip.route = extractedTrip["เส้นทาง"];
    trip.cost_type = extractedTrip["ประเภทการจ่าย"];
    trip.trip_type = extractedTrip["รูปแบบของทริป"];
    trip.shift_type = extractedTrip["ประเภทการเดินทาง"];
    trip.standby_datetime = extractedTrip["วันที่เวลาสแตนบาย"];
    if (extractedTrip.assignment_status !== undefined) trip.assignment_status = extractedTrip.assignment_status;
  }
  const listAgeMs = numericValue(itemRecord.listAgeMs);
  if (listAgeMs !== null && listAgeMs >= 0) trip.listAgeMs = Math.floor(listAgeMs);

  return {
    requestId,
    acceptanceStatus: status,
    trip,
  };
}

type FastAcceptAllListRead =
  | { ok: true; items: FastAcceptAllRequestListItem[] }
  | { ok: false };

type FastAcceptAllObservedTripsRead =
  | { ok: true; trips: FastAcceptAllObservedTrip[] }
  | { ok: false };

async function readFastAcceptAllList(
  apiClient: AutoAcceptJobRealExecutionApi,
  bookingId: number,
  tabPendingConfirmation: boolean,
): Promise<FastAcceptAllListRead> {
  try {
    const response = await apiClient.fetchBookingRequestList(bookingId, {
      tabPendingConfirmation,
    });
    if (!response || !response.data || !Array.isArray(response.data.request_list)) {
      return { ok: false };
    }
    return { ok: true, items: response.data.request_list };
  } catch {
    return { ok: false };
  }
}

async function fetchFastAcceptAllObservedTrips(
  apiClient: AutoAcceptJobRealExecutionApi,
  payload: AutoAcceptDryRunPayloadV1,
): Promise<FastAcceptAllObservedTripsRead> {
  const [pending, confirmed] = await Promise.all([
    readFastAcceptAllList(apiClient, payload.bookingId, true),
    readFastAcceptAllList(apiClient, payload.bookingId, false),
  ]);
  if (!pending.ok || !confirmed.ok) return { ok: false };

  const byRequestId = new Map<number, FastAcceptAllObservedTrip>();
  for (const item of [...pending.items, ...confirmed.items]) {
    const trip = normalizeFastAcceptAllTrip(item, payload);
    if (!trip) return { ok: false };
    byRequestId.set(trip.requestId, trip);
  }
  return {
    ok: true,
    trips: [...byRequestId.values()].sort((left, right) => left.requestId - right.requestId),
  };
}

function fastAcceptAllChildPayload(input: {
  parentPayload: AutoAcceptDryRunPayloadV1;
  child: FastAcceptAllObservedTrip;
  traceId: string;
}): AutoAcceptDryRunPayloadV1 {
  const identity = {
    teamId: input.parentPayload.teamId,
    ...(input.parentPayload.cutoverEpoch
      ? { cutoverEpoch: input.parentPayload.cutoverEpoch }
      : {}),
    bookingId: input.parentPayload.bookingId,
    requestId: input.child.requestId,
    ruleId: input.parentPayload.ruleId,
    attemptKind: "own_status_reconcile" as const,
  };
  return {
    executionMode: "cutover",
    schemaVersion: 1,
    idempotencyKey: buildAutoAcceptJobIdempotencyKey(identity),
    attemptKind: identity.attemptKind,
    teamId: identity.teamId,
    bookingId: identity.bookingId,
    requestId: identity.requestId,
    ruleId: identity.ruleId,
    ruleName: input.parentPayload.ruleName,
    acceptAll: false,
    source: "reconciliation",
    trip: input.child.trip,
    ruleSnapshot: {
      ...input.parentPayload.ruleSnapshot,
      accept_all: false,
    },
    observedAt: input.parentPayload.observedAt,
    pollerNodeId: input.parentPayload.pollerNodeId,
    ...(input.parentPayload.cutoverEpoch
      ? { cutoverEpoch: input.parentPayload.cutoverEpoch }
      : {}),
    ...(input.parentPayload.pollerLeaseOwnerId ? { pollerLeaseOwnerId: input.parentPayload.pollerLeaseOwnerId } : {}),
    ...(input.parentPayload.bookingName ? { bookingName: input.parentPayload.bookingName } : {}),
    ...(input.parentPayload.bookingCreatedAtMs !== undefined ? { bookingCreatedAtMs: input.parentPayload.bookingCreatedAtMs } : {}),
    traceParent: input.traceId,
  };
}

function durableFastAcceptAllOwnedTrip(
  row: AutoAcceptResultRow,
  payload: AutoAcceptDryRunPayloadV1,
): FastAcceptAllObservedTrip | null {
  if (row.status !== "owned" || !row.evidenceJson) return null;

  let evidence: unknown;
  try {
    evidence = JSON.parse(row.evidenceJson);
  } catch {
    return null;
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const evidenceRecord = evidence as Record<string, unknown>;
  if (
    evidenceRecord.source !== "fast_accept_all_reconcile" ||
    evidenceRecord.acceptAll !== true ||
    !evidenceRecord.trip ||
    typeof evidenceRecord.trip !== "object" ||
    Array.isArray(evidenceRecord.trip)
  ) return null;

  const observedStatus = numericValue(evidenceRecord.observedStatus);
  const foundAcceptedCount = numericValue(evidenceRecord.foundAcceptedCount);
  const observedCount = numericValue(evidenceRecord.observedCount);
  if (
    observedStatus !== 2 ||
    foundAcceptedCount === null ||
    !Number.isInteger(foundAcceptedCount) ||
    foundAcceptedCount <= 0 ||
    observedCount === null ||
    !Number.isInteger(observedCount) ||
    observedCount < foundAcceptedCount
  ) return null;

  const requestId = numericValue(row.requestId);
  if (requestId === null || !Number.isInteger(requestId) || requestId <= 0) return null;
  const trip = evidenceRecord.trip as Record<string, unknown>;
  const tripRequestId = numericValue(trip.request_id);
  const tripBookingId = numericValue(trip.booking_id);
  const tripAcceptanceStatus = numericValue(trip.acceptance_status) ?? numericValue(trip.request_acceptance_status);
  if (
    tripRequestId !== requestId ||
    tripBookingId !== payload.bookingId ||
    tripAcceptanceStatus !== 2
  ) return null;

  const sanitizedTrip: Record<string, unknown> = {
    request_id: requestId,
    booking_id: payload.bookingId,
    acceptance_status: 2,
  };
  for (const key of [
    "origin",
    "destination",
    "route",
    "cost_type",
    "trip_type",
    "shift_type",
    "vehicle_type",
    "standby_datetime",
    "booking_name",
    "agency_name",
  ]) {
    const value = textValue(trip[key]);
    if (value) sanitizedTrip[key] = value;
  }
  for (const key of ["assignment_status", "listAgeMs"]) {
    const value = numericValue(trip[key]);
    if (value !== null && Number.isInteger(value) && value >= 0) sanitizedTrip[key] = value;
  }

  return {
    requestId,
    acceptanceStatus: 2,
    trip: sanitizedTrip,
  };
}

function attemptDateMs(value: unknown, fallback: number): number {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toVerificationJobFromAttempt(input: {
  payload: AutoAcceptDryRunPayloadV1;
  traceId: string;
  attempt: AutoAcceptAttemptRow;
}): AutoAcceptVerificationJob {
  const fallbackStartedAt = Date.now();
  const acceptStartedAt = attemptDateMs(input.attempt.acceptStartedAt, fallbackStartedAt);
  const incomplete = input.attempt.acceptFinishedAt === null;
  const acceptFinishedAt = attemptDateMs(input.attempt.acceptFinishedAt, acceptStartedAt);
  const acceptRttMs = input.attempt.acceptRttMs ?? Math.max(0, acceptFinishedAt - acceptStartedAt);
  const httpStatus = input.attempt.spxHttpStatus ?? 0;
  const ambiguousAccept = incomplete || input.attempt.ambiguousAccept === 1;
  const ok = !incomplete &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    (input.attempt.spxRetcode === null || input.attempt.spxRetcode === 0) &&
    input.attempt.rawError === null;

  return {
    teamId: input.payload.teamId,
    ruleId: input.payload.ruleId,
    ruleName: input.payload.ruleName,
    bookingId: input.payload.bookingId,
    requestIds: [input.payload.requestId],
    trips: tripListFor(input.payload),
    claimToken: 0,
    acceptResult: {
      ok,
      httpStatus,
      ...(input.attempt.spxRetcode !== null ? { retcode: input.attempt.spxRetcode } : {}),
      ...(input.attempt.spxMessage !== null ? { message: input.attempt.spxMessage } : {}),
      ...(input.attempt.rawError !== null
        ? { error: input.attempt.rawError }
        : incomplete
          ? { error: "external attempt response unavailable" }
          : {}),
    },
    acceptStartedAt,
    acceptFinishedAt,
    acceptRttMs,
    ambiguousAccept,
    acceptAll: false,
    traceId: input.traceId,
    ...(listAgeMsFor(input.payload) !== undefined
      ? { listAgeMs: listAgeMsFor(input.payload) }
      : {}),
  };
}

async function checkpointExistingCanonicalResult(
  context: AutoAcceptJobExecutionContext,
  payload: AutoAcceptDryRunPayloadV1,
  retryDelayMs: number,
  releaseBudgetOnTerminal: boolean,
): Promise<AutoAcceptJobExecutionResult | null> {
  const existing = await getAutoAcceptResult(payload.teamId, payload.bookingId, payload.requestId);
  if (
    !existing ||
    !existing.status ||
    existing.status === "unknown" ||
    !existing.reasonCode
  ) return null;

  if (releaseBudgetOnTerminal && shouldReleaseBudgetReservation(existing.status)) {
    await releaseAutoAcceptRuleBudgetOnce({
      jobId: context.row.id,
      teamId: payload.teamId,
      bookingId: payload.bookingId,
      requestIds: [payload.requestId],
      ruleId: payload.ruleId,
      acceptedCount: 1,
      traceId: existing.winningAttemptTraceId,
      reasonCode: existing.reasonCode,
      now: context.now,
    });
  }

  const checkpointed = await context.checkpointResult({
    resultStatus: existing.status as AutoAcceptJobResultStatus,
    resultReasonCode: existing.reasonCode,
    winningAttemptTraceId: existing.winningAttemptTraceId,
  });

  if (!checkpointed) {
    return retry({
      reasonCode: "real_execution_result_checkpoint_failed",
      error: "existing canonical result checkpoint could not be written",
      retryDelayMs,
    });
  }

  return retry({
    reasonCode: "settlement_pending",
    error: "settlement pending for existing canonical result",
    retryDelayMs,
  });
}

async function executeOwnStatusReconcile(
  context: AutoAcceptJobExecutionContext,
  payload: AutoAcceptDryRunPayloadV1,
  retryDelayMs: number,
  options: AutoAcceptJobRealExecutionOptions,
): Promise<AutoAcceptJobExecutionResult> {
  if (context.row.resultStatus || context.row.resultReasonCode || context.row.winningAttemptTraceId) {
    return retry({
      reasonCode: "settlement_pending",
      error: "canonical result checkpoint already exists",
      retryDelayMs,
    });
  }

  const existingCanonicalResult = await checkpointExistingCanonicalResult(context, payload, retryDelayMs, false);
  if (existingCanonicalResult) return existingCanonicalResult;

  const mutableValidation = await validateAutoAcceptJobDryRunRuleState(context.row, payload, {
    loadRuleState: options.loadRuleState,
  });
  if (!mutableValidation.ok) return validationFailureExecution(mutableValidation, options);

  const status = observedAcceptanceStatus(payload);
  if (status !== 2) {
    return {
      outcome: "dead_letter",
      reasonCode: "own_status_reconcile_not_owned",
      error: `own_status_reconcile requires observed accepted status 2, got ${status ?? "missing"}`,
    };
  }

  const traceId = buildAutoAcceptTraceId({
    teamId: payload.teamId,
    bookingId: payload.bookingId,
    requestIds: [payload.requestId],
    acceptStartedAt: context.now.getTime(),
  });

  await upsertAutoAcceptResult({
    teamId: payload.teamId,
    bookingId: payload.bookingId,
    requestId: payload.requestId,
    winningAttemptTraceId: traceId,
    status: "owned",
    reasonCode: "verified_owned",
    evidence: {
      source: "own_status_reconcile",
      observedStatus: status,
      acceptAll: payload.acceptAll,
    },
  });

  const checkpointed = await context.checkpointResult({
    resultStatus: "owned",
    resultReasonCode: "verified_owned",
    winningAttemptTraceId: traceId,
  });
  if (!checkpointed) {
    return retry({
      reasonCode: "real_execution_result_checkpoint_failed",
      error: errorMessage("canonical result checkpoint could not be written"),
      retryDelayMs: DEFAULT_CHECKPOINT_RETRY_DELAY_MS,
    });
  }

  return retry({
    reasonCode: "settlement_pending",
    error: "settlement pending after own_status_reconcile canonical result",
    retryDelayMs,
  });
}

async function executeFastAcceptAllParent(
  context: AutoAcceptJobExecutionContext,
  payload: AutoAcceptDryRunPayloadV1,
  options: AutoAcceptJobRealExecutionOptions,
): Promise<AutoAcceptJobExecutionResult> {
  const retryDelayMs = options.retryDelayMsOnSettlementPending ?? DEFAULT_SETTLEMENT_PENDING_RETRY_DELAY_MS;
  if (context.row.resultStatus || context.row.resultReasonCode || context.row.winningAttemptTraceId) {
    return {
      outcome: "failed",
      resultStatus: "failed",
      reasonCode: "fast_accept_all_result_checkpoint_exists",
      winningAttemptTraceId: context.row.winningAttemptTraceId,
    };
  }

  const resolution = await resolveExternalAttempt(
    context,
    payload,
    retryDelayMs,
    "accept_all",
  );
  if (resolution.kind === "retry" || resolution.kind === "conflict") {
    return resolution.execution;
  }

  const traceId = resolution.traceId;
  let attempt = resolution.kind === "existing" ? resolution.row : null;
  if (resolution.kind === "new") {
    const mutableValidation = await validateAutoAcceptJobDryRunRuleState(context.row, payload, {
      loadRuleState: options.loadRuleState,
    });
    if (!mutableValidation.ok) return validationFailureExecution(mutableValidation, options);

    if (!options.apiClient.acceptAllBookingRequests) {
      return {
        outcome: "dead_letter",
        reasonCode: "fast_accept_all_api_not_configured",
        error: "real execution API client does not support acceptAllBookingRequests",
      };
    }

    const policyResult = await applyNewExternalAttemptPolicy(context, payload, options);
    if (policyResult) return policyResult;

    const publicationResult = await enforceCurrentPublication(context, options);
    if (publicationResult) return publicationResult;

    let renewedBeforeBegin: boolean;
    try {
      renewedBeforeBegin = await context.renewClaim();
    } catch {
      renewedBeforeBegin = false;
    }
    if (!renewedBeforeBegin) {
      return externalAttemptRetry(
        "external_attempt_claim_lost",
        retryDelayMs,
        "active claim was lost before external attempt marker creation",
      );
    }

    const publicationBeforeBegin = await enforceCurrentPublication(context, options);
    if (publicationBeforeBegin) return publicationBeforeBegin;

    const acceptStartedAtDate = context.currentTime();
    let begun: Awaited<ReturnType<typeof beginAutoAcceptAttempt>>;
    try {
      begun = await beginAutoAcceptAttempt(externalAttemptBeginInput({
        context,
        payload,
        traceId,
        acceptStartedAt: acceptStartedAtDate,
        acceptMode: "accept_all",
      }));
    } catch (error) {
      if (isAttemptIdentityConflict(error)) {
        return externalAttemptRetry(
          "external_attempt_identity_conflict",
          retryDelayMs,
          "external attempt identity conflict",
        );
      }
      return externalAttemptRetry(
        "external_attempt_begin_uncertain",
        retryDelayMs,
        "external attempt marker creation outcome is uncertain",
      );
    }

    if (begun.kind === "existing") {
      attempt = begun.row;
    } else {
      let renewedBeforePost: boolean;
      try {
        renewedBeforePost = await context.renewClaim();
      } catch {
        renewedBeforePost = false;
      }
      if (!renewedBeforePost) {
        return externalAttemptRetry(
          "external_attempt_claim_lost",
          retryDelayMs,
          "active claim was lost before external accept request",
        );
      }

      const publicationBeforePost = await enforceCurrentPublication(context, options);
      if (publicationBeforePost) return publicationBeforePost;

      const acceptStartedAt = acceptStartedAtDate.getTime();
      const wallStartedAt = Date.now();
      if (payload.firstMatchedAtMs !== undefined) {
        (options.metricsCollector ?? metrics).recordInterval("firstMatchToAcceptStart", payload.firstMatchedAtMs, wallStartedAt);
      }
      let acceptResult: Awaited<ReturnType<NonNullable<AutoAcceptJobRealExecutionApi["acceptAllBookingRequests"]>>>;
      try {
        acceptResult = await options.apiClient.acceptAllBookingRequests(payload.bookingId);
      } catch {
        return externalAttemptRetry(
          "external_attempt_post_uncertain",
          retryDelayMs,
          "external accept request outcome is uncertain",
        );
      }

      const acceptRttMs = Math.max(0, Date.now() - wallStartedAt);
      try {
        const completed = await completeAutoAcceptAttempt({
          traceId,
          teamId: payload.teamId,
          bookingId: payload.bookingId,
          acceptMode: "accept_all",
          requestIds: [],
          ruleId: payload.ruleId,
          ruleName: payload.ruleName,
          acceptFinishedAt: new Date(acceptStartedAt + acceptRttMs),
          acceptRttMs,
          spxHttpStatus: acceptResult.httpStatus,
          spxRetcode: acceptResult.response?.retcode ?? null,
          spxMessage: acceptResult.response?.message ?? null,
          rawError: acceptResult.error ?? null,
          ambiguousAccept: acceptResult.httpStatus === 0,
        });
        attempt = completed.row;
      } catch (error) {
        if (isAttemptIdentityConflict(error)) {
          return externalAttemptRetry(
            "external_attempt_identity_conflict",
            retryDelayMs,
            "external attempt identity conflict",
          );
        }
        return externalAttemptRetry(
          "external_attempt_completion_uncertain",
          retryDelayMs,
          "external attempt completion outcome is uncertain",
        );
      }
    }
  }

  if (!attempt) {
    return externalAttemptRetry(
      "external_attempt_validation_failed",
      retryDelayMs,
      "external attempt marker validation failed",
    );
  }
  const attemptIsAmbiguous = attempt.acceptFinishedAt === null || attempt.ambiguousAccept === 1;

  let observedRead: FastAcceptAllObservedTripsRead;
  try {
    observedRead = await fetchFastAcceptAllObservedTrips(options.apiClient, payload);
  } catch {
    observedRead = { ok: false };
  }
  if (!observedRead.ok) {
    return externalAttemptRetry(
      "fast_accept_all_reconcile_unreadable",
      retryDelayMs,
      "fast accept-all request tabs were unreadable",
    );
  }

  const observedTrips = observedRead.trips;
  const ambiguousObservationPending = attemptIsAmbiguous && (
    observedTrips.length === 0 || observedTrips.some((trip) => trip.acceptanceStatus !== 2)
  );
  const foundAcceptedCount = observedTrips.filter((trip) => trip.acceptanceStatus === 2).length;
  const enqueueChild = options.enqueueFastAcceptAllChildJob ?? enqueueAutoAcceptJob;
  try {
    for (const trip of observedTrips) {
      const owned = trip.acceptanceStatus === 2;
      if (!owned && attemptIsAmbiguous) continue;
      await upsertAutoAcceptResult({
        teamId: payload.teamId,
        bookingId: payload.bookingId,
        requestId: trip.requestId,
        winningAttemptTraceId: traceId,
        status: owned ? "owned" : "lost",
        reasonCode: owned ? "verified_owned" : "verified_not_owned",
        evidence: {
          source: "fast_accept_all_reconcile",
          acceptAll: true,
          observedStatus: trip.acceptanceStatus,
          foundAcceptedCount,
          observedCount: observedTrips.length,
          trip: trip.trip,
        },
      });
      await options.afterFastAcceptAllCanonicalResult?.({
        traceId,
        requestId: trip.requestId,
      });
    }

    const durableOwnedRows = await listOwnedAutoAcceptResultsByWinningTrace({
      teamId: payload.teamId,
      bookingId: payload.bookingId,
      winningAttemptTraceId: traceId,
    });
    const durableOwnedTrips: FastAcceptAllObservedTrip[] = [];
    for (const row of durableOwnedRows) {
      const trip = durableFastAcceptAllOwnedTrip(row, payload);
      if (!trip) {
        return externalAttemptRetry(
          "fast_accept_all_durable_child_unreadable",
          retryDelayMs,
          "fast accept-all durable child evidence was unreadable",
        );
      }
      durableOwnedTrips.push(trip);
    }

    for (const trip of durableOwnedTrips) {
      const childPayload = fastAcceptAllChildPayload({
        parentPayload: payload,
        child: trip,
        traceId,
      });
      const durableChild = await enqueueChild({
        executionMode: "cutover",
        teamId: childPayload.teamId,
        ...(childPayload.cutoverEpoch ? { cutoverEpoch: childPayload.cutoverEpoch } : {}),
        bookingId: childPayload.bookingId,
        requestId: childPayload.requestId,
        ruleId: childPayload.ruleId,
        attemptKind: childPayload.attemptKind,
        payload: childPayload,
        observedAt: new Date(childPayload.observedAt),
      });
      const childValidation = validateAutoAcceptJobDryRunPayloadStructure(durableChild);
      if (!childValidation.ok || childValidation.payload.executionMode !== "cutover") {
        return externalAttemptRetry("fast_accept_all_child_admission_conflict", retryDelayMs,
          "existing child admission requires explicit reconciliation");
      }
    }

    if (ambiguousObservationPending) {
      return externalAttemptRetry(
        "fast_accept_all_verification_indeterminate",
        retryDelayMs,
        "fast accept-all ownership verification is not terminal",
      );
    }

    if (durableOwnedTrips.length === 0) {
      return {
        outcome: "failed",
        resultStatus: "failed",
        reasonCode: "fast_accept_all_no_verified_owned_requests",
        winningAttemptTraceId: traceId,
      };
    }
  } catch {
    return externalAttemptRetry(
      "fast_accept_all_child_replay_failed",
      retryDelayMs,
      "fast accept-all child replay failed",
    );
  }

  return {
    outcome: "succeeded",
    resultStatus: "owned",
    reasonCode: "fast_accept_all_children_enqueued",
    winningAttemptTraceId: traceId,
  };
}

export function createAutoAcceptJobRealExecutionExecutor(
  options: AutoAcceptJobRealExecutionOptions,
): AutoAcceptJobExecutor {
  return (context) => executeAutoAcceptJobRealRequest(context, options);
}

export async function executeAutoAcceptJobRealRequest(
  context: AutoAcceptJobExecutionContext,
  options: AutoAcceptJobRealExecutionOptions,
): Promise<AutoAcceptJobExecutionResult> {
  const structuralValidation = validateAutoAcceptJobDryRunPayloadStructure(context.row);
  if (!structuralValidation.ok) {
    return validationFailureExecution(structuralValidation, options);
  }

  const { payload } = structuralValidation;
  const admissionRejection = rejectUnadmittedAutoAcceptJob(payload.executionMode);
  if (admissionRejection) return admissionRejection;
  const initialPublicationResult = await enforceCurrentPublication(context, options);
  if (initialPublicationResult) return initialPublicationResult;
  const retryDelayMs = options.retryDelayMsOnSettlementPending ?? DEFAULT_SETTLEMENT_PENDING_RETRY_DELAY_MS;
  if (payload.attemptKind === "fast_accept_all") {
    return await executeFastAcceptAllParent(context, payload, options);
  }
  if (payload.attemptKind === "own_status_reconcile") {
    return await executeOwnStatusReconcile(context, payload, retryDelayMs, options);
  }

  const usesBudgetReservation = payload.attemptKind === "pending_request";
  const isSupportedRequestLevelAttempt = payload.attemptKind === "pending_request" ||
    payload.attemptKind === "non_pending_probe";

  if (!isSupportedRequestLevelAttempt) {
    return {
      outcome: "dead_letter",
      reasonCode: "real_execution_attempt_kind_not_supported",
      error: `attemptKind ${payload.attemptKind} is not supported by real request executor`,
    };
  }

  if (
    (context.row.resultStatus && context.row.resultStatus !== "unknown") ||
    (context.row.resultReasonCode && context.row.resultStatus !== "unknown") ||
    (context.row.winningAttemptTraceId && context.row.resultStatus !== "unknown")
  ) {
    return retry({
      reasonCode: "settlement_pending",
      error: "canonical result checkpoint already exists",
      retryDelayMs: options.retryDelayMsOnSettlementPending ?? DEFAULT_SETTLEMENT_PENDING_RETRY_DELAY_MS,
    });
  }

  let existingCanonicalResult: AutoAcceptJobExecutionResult | null;
  try {
    existingCanonicalResult = await checkpointExistingCanonicalResult(
      context,
      payload,
      retryDelayMs,
      usesBudgetReservation,
    );
  } catch {
    return externalAttemptRetry(
      "real_execution_canonical_lookup_failed",
      options.retryDelayMsOnCheckpointError ?? DEFAULT_CHECKPOINT_RETRY_DELAY_MS,
      "canonical result lookup failed",
    );
  }
  if (existingCanonicalResult) return existingCanonicalResult;

  const resolution = await resolveExternalAttempt(
    context,
    payload,
    retryDelayMs,
    "request_ids",
  );
  if (resolution.kind === "retry" || resolution.kind === "conflict") {
    return resolution.execution;
  }

  const traceId = resolution.traceId;
  let attempt: AutoAcceptAttemptRow;
  if (resolution.kind === "existing") {
    attempt = resolution.row;
  } else {
    const mutableValidation = await validateAutoAcceptJobDryRunRuleState(context.row, payload, {
      loadRuleState: options.loadRuleState,
    });
    if (!mutableValidation.ok) return validationFailureExecution(mutableValidation, options);

    const policyResult = await applyNewExternalAttemptPolicy(context, payload, options);
    if (policyResult) return policyResult;

    const publicationResult = await enforceCurrentPublication(context, options);
    if (publicationResult) return publicationResult;

    if (usesBudgetReservation) {
      await reconcileStaleBudgetReservations({
        payload,
        apiClient: options.apiClient,
        now: context.now,
        ttlMs: options.staleBudgetReservationTtlMs,
        limit: options.staleBudgetReservationLimit,
      });
      const reserved = await reserveAutoAcceptRuleBudgetOnce({
        jobId: context.row.id,
        teamId: payload.teamId,
        bookingId: payload.bookingId,
        requestIds: [payload.requestId],
        ruleId: payload.ruleId,
        acceptedCount: 1,
        reasonCode: "real_execution_budget_reservation",
        now: context.now,
      });
      if (!reserved.reserved) {
        return retry({
          reasonCode: reserved.reasonCode ?? "rule_budget_exhausted",
          error: "rule budget is reserved or exhausted by another in-flight auto-accept job",
          retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
        });
      }
    }

    let renewedBeforeBegin: boolean;
    try {
      renewedBeforeBegin = await context.renewClaim();
    } catch {
      renewedBeforeBegin = false;
    }
    if (!renewedBeforeBegin) {
      return externalAttemptRetry(
        "external_attempt_claim_lost",
        retryDelayMs,
        "active claim was lost before external attempt marker creation",
      );
    }

    const publicationBeforeBegin = await enforceCurrentPublication(context, options);
    if (publicationBeforeBegin) return publicationBeforeBegin;

    const acceptStartedAtDate = context.currentTime();
    let begun: Awaited<ReturnType<typeof beginAutoAcceptAttempt>>;
    try {
      begun = await beginAutoAcceptAttempt(externalAttemptBeginInput({
        context,
        payload,
        traceId,
        acceptStartedAt: acceptStartedAtDate,
        acceptMode: "request_ids",
      }));
    } catch (error) {
      if (isAttemptIdentityConflict(error)) {
        return externalAttemptRetry(
          "external_attempt_identity_conflict",
          retryDelayMs,
          "external attempt identity conflict",
        );
      }
      return externalAttemptRetry(
        "external_attempt_begin_uncertain",
        retryDelayMs,
        "external attempt marker creation outcome is uncertain",
      );
    }

    if (begun.kind === "existing") {
      attempt = begun.row;
    } else {
      let renewedBeforePost: boolean;
      try {
        renewedBeforePost = await context.renewClaim();
      } catch {
        renewedBeforePost = false;
      }
      if (!renewedBeforePost) {
        return externalAttemptRetry(
          "external_attempt_claim_lost",
          retryDelayMs,
          "active claim was lost before external accept request",
        );
      }

      const publicationBeforePost = await enforceCurrentPublication(context, options);
      if (publicationBeforePost) return publicationBeforePost;

      const acceptStartedAt = acceptStartedAtDate.getTime();
      const wallStartedAt = Date.now();
      if (payload.firstMatchedAtMs !== undefined) {
        (options.metricsCollector ?? metrics).recordInterval("firstMatchToAcceptStart", payload.firstMatchedAtMs, wallStartedAt);
      }
      let acceptResult: Awaited<ReturnType<AutoAcceptJobRealExecutionApi["acceptBookingRequests"]>>;
      try {
        acceptResult = await options.apiClient.acceptBookingRequests(
          payload.bookingId,
          [payload.requestId],
        );
      } catch {
        return externalAttemptRetry(
          "external_attempt_post_uncertain",
          retryDelayMs,
          "external accept request outcome is uncertain",
        );
      }

      const acceptRttMs = Math.max(0, Date.now() - wallStartedAt);
      const acceptFinishedAt = acceptStartedAt + acceptRttMs;
      try {
        const completed = await completeAutoAcceptAttempt({
          traceId,
          teamId: payload.teamId,
          bookingId: payload.bookingId,
          requestIds: [payload.requestId],
          ruleId: payload.ruleId,
          ruleName: payload.ruleName,
          acceptMode: "request_ids",
          acceptFinishedAt: new Date(acceptFinishedAt),
          acceptRttMs,
          spxHttpStatus: acceptResult.httpStatus,
          spxRetcode: acceptResult.response?.retcode ?? null,
          spxMessage: acceptResult.response?.message ?? null,
          rawError: acceptResult.error ?? null,
          ambiguousAccept: acceptResult.httpStatus === 0,
        });
        attempt = completed.row;
      } catch (error) {
        if (isAttemptIdentityConflict(error)) {
          return externalAttemptRetry(
            "external_attempt_identity_conflict",
            retryDelayMs,
            "external attempt identity conflict",
          );
        }
        return externalAttemptRetry(
          "external_attempt_completion_uncertain",
          retryDelayMs,
          "external attempt completion outcome is uncertain",
        );
      }
    }
  }

  let verification: Awaited<ReturnType<typeof verifyAutoAcceptJob>>;
  try {
    verification = await verifyAutoAcceptJob(
      options.apiClient as unknown as ApiClient,
      toVerificationJobFromAttempt({ payload, traceId, attempt }),
      { ambiguousRecheckDelayMs: options.ambiguousRecheckDelayMs },
    );
  } catch {
    return externalAttemptRetry(
      "external_attempt_verification_failed",
      retryDelayMs,
      "external attempt verification failed",
    );
  }
  const request = verification.requests.find((item) => item.requestId === payload.requestId);
  const canonical = canonicalResultForVerifiedRequest(request);

  try {
    await upsertAutoAcceptResult({
      teamId: payload.teamId,
      bookingId: payload.bookingId,
      requestId: payload.requestId,
      winningAttemptTraceId: traceId,
      status: canonical.status,
      reasonCode: canonical.reasonCode,
      evidence: verification.evidence,
    });
  } catch {
    return externalAttemptRetry(
      "external_attempt_canonical_write_failed",
      options.retryDelayMsOnCheckpointError ?? DEFAULT_CHECKPOINT_RETRY_DELAY_MS,
      "external attempt canonical result write failed",
    );
  }

  if (canonical.status === "unknown") {
    return externalAttemptRetry(
      canonical.reasonCode,
      retryDelayMs,
      "external attempt verification is not terminal",
    );
  }

  if (usesBudgetReservation && shouldReleaseBudgetReservation(canonical.status)) {
    try {
      await releaseAutoAcceptRuleBudgetOnce({
        jobId: context.row.id,
        teamId: payload.teamId,
        bookingId: payload.bookingId,
        requestIds: [payload.requestId],
        ruleId: payload.ruleId,
        acceptedCount: 1,
        traceId,
        reasonCode: canonical.reasonCode,
        now: context.currentTime(),
      });
    } catch {
      return externalAttemptRetry(
        "external_attempt_budget_release_failed",
        retryDelayMs,
        "external attempt budget release failed",
      );
    }
  }

  let checkpointed: boolean;
  try {
    checkpointed = await context.checkpointResult({
      resultStatus: canonical.status as AutoAcceptJobResultStatus,
      resultReasonCode: canonical.reasonCode,
      winningAttemptTraceId: traceId,
    });
  } catch {
    checkpointed = false;
  }
  if (!checkpointed) {
    return retry({
      reasonCode: "real_execution_result_checkpoint_failed",
      error: errorMessage("canonical result checkpoint could not be written"),
      retryDelayMs: options.retryDelayMsOnCheckpointError ?? DEFAULT_CHECKPOINT_RETRY_DELAY_MS,
    });
  }

  return retry({
    reasonCode: "settlement_pending",
    error: "settlement pending after canonical result",
    retryDelayMs,
  });
}

export function runAutoAcceptJobRealExecutionBatch(
  input: RunAutoAcceptJobRealExecutionBatchInput,
): Promise<AutoAcceptWorkerBatchResult> {
  const {
    apiClient,
    metricsCollector,
    loadRuleState,
    canStartNewExternalAttempt,
    ambiguousRecheckDelayMs,
    retryDelayMsOnRuleStateError,
    retryDelayMsOnSettlementPending,
    retryDelayMsOnCheckpointError,
    staleBudgetReservationTtlMs,
    staleBudgetReservationLimit,
    enqueueFastAcceptAllChildJob,
    afterFastAcceptAllCanonicalResult,
    ...workerInput
  } = input;

  return runAutoAcceptWorkerBatch({
    ...workerInput,
    execute: createAutoAcceptJobRealExecutionExecutor({
      apiClient,
      metricsCollector,
      loadRuleState,
      canStartNewExternalAttempt,
      ambiguousRecheckDelayMs,
      retryDelayMsOnRuleStateError,
      retryDelayMsOnSettlementPending,
      retryDelayMsOnCheckpointError,
      staleBudgetReservationTtlMs,
      staleBudgetReservationLimit,
      enqueueFastAcceptAllChildJob,
      afterFastAcceptAllCanonicalResult,
    }),
  });
}
