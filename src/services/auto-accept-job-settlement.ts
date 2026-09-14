import {
  buildAutoAcceptJobIdempotencyKey,
  type AutoAcceptAttemptKind,
  type AutoAcceptJobExecutionMode,
  type AutoAcceptJobResultStatus,
  type AutoAcceptJobRow,
} from "../repositories/auto-accept-job-repository.js";
import {
  settleAutoAcceptProgressOnce,
  writeAutoAcceptHistoryOnce,
} from "../repositories/auto-accept-job-settlement-repository.js";
import { type AutoAcceptRecord } from "../repositories/auto-accept-repository.js";
import {
  insertBookingHistory,
  type BookingHistoryRecord,
} from "../repositories/booking-history-repository.js";
import {
  runAutoAcceptWorkerBatch,
  type AutoAcceptJobExecutionContext,
  type AutoAcceptJobExecutionResult,
  type AutoAcceptWorkerBatchResult,
  type RunAutoAcceptWorkerBatchInput,
} from "./auto-accept-worker.js";
import { refreshRulesAfterAutoAcceptSettlement } from "./notify-rules.js";
import { createWorkerNotificationPublisher, type NotificationPublisher } from "./notification-publisher.js";
import { rejectUnadmittedAutoAcceptJob } from "./auto-accept-job-admission.js";
import { assertJobPublicationCurrent } from "../repositories/auto-accept-publication-control-repository.js";

export interface AutoAcceptJobSettlementPayloadV1 {
  executionMode?: AutoAcceptJobExecutionMode;
  cutoverEpoch?: string;
  schemaVersion: 1;
  idempotencyKey: string;
  attemptKind: AutoAcceptAttemptKind;
  teamId: number;
  bookingId: number;
  requestId: number;
  ruleId: string;
  ruleName: string;
  acceptAll: boolean;
  source: "pending_tab" | "non_pending_tab" | "booking_name" | "reconciliation";
  trip?: {
    request_id?: number;
    booking_id?: number;
    origin?: string;
    destination?: string;
    route?: string;
    cost_type?: string;
    trip_type?: string;
    shift_type?: string;
    vehicle_type?: string;
    standby_datetime?: string;
    booking_name?: string;
    agency_name?: string;
    acceptance_status?: number;
    assignment_status?: number;
    listAgeMs?: number;
  };
  observedAt: string;
  pollerNodeId: string;
}

export interface AutoAcceptJobProgressSettlement {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestIds: number[];
  ruleId: string;
  acceptedCount: number;
  traceId?: string | null;
  reasonCode: string;
}

export interface AutoAcceptJobHistorySettlement {
  jobId: number;
  teamId: number;
  record: AutoAcceptRecord;
  bookingHistoryRecord?: BookingHistoryRecord;
}

export interface AutoAcceptJobNotificationSettlement {
  jobId: number;
  teamId: number;
  bookingId: number;
  requestIds: number[];
  ruleId: string;
  ruleName: string;
  traceId?: string | null;
  message: string;
  evidence: Record<string, unknown>;
}

export interface AutoAcceptJobSettlementOperations {
  settleProgress(input: AutoAcceptJobProgressSettlement): Promise<void> | void;
  writeHistory(input: AutoAcceptJobHistorySettlement): Promise<void> | void;
  enqueueNotification(input: AutoAcceptJobNotificationSettlement): Promise<void> | void;
}

export interface AutoAcceptJobSettlementOptions {
  operations: AutoAcceptJobSettlementOperations;
  retryDelayMsOnSettlementError?: number;
}

export interface RunAutoAcceptJobSettlementBatchInput
  extends Omit<RunAutoAcceptWorkerBatchInput, "execute">,
    AutoAcceptJobSettlementOptions {}

export interface CreateAutoAcceptJobSettlementOperationsOptions {
  publisher?: NotificationPublisher;
  teamName?: string | ((teamId: number) => string);
}

type PayloadResult =
  | { ok: true; payload: AutoAcceptJobSettlementPayloadV1 }
  | { ok: false; reasonCode: string; error: string; retryable?: boolean };

const DEFAULT_SETTLEMENT_RETRY_DELAY_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isAttemptKind(value: unknown): value is AutoAcceptAttemptKind {
  return value === "pending_request" ||
    value === "non_pending_probe" ||
    value === "fast_accept_all" ||
    value === "own_status_reconcile";
}

function isSource(value: unknown): value is AutoAcceptJobSettlementPayloadV1["source"] {
  return value === "pending_tab" ||
    value === "non_pending_tab" ||
    value === "booking_name" ||
    value === "reconciliation";
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isInteger(value) ? value as number : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidPayload(error: string): PayloadResult {
  return { ok: false, reasonCode: "settlement_invalid_payload", error };
}

function parsePayloadJson(row: AutoAcceptJobRow): PayloadResult | { parsed: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (!isRecord(parsed)) return invalidPayload("payload must be a JSON object");
    return { parsed };
  } catch {
    return {
      ok: false,
      reasonCode: "settlement_invalid_payload_json",
      error: "payloadJson is not valid JSON",
    };
  }
}

function readTrip(value: unknown): AutoAcceptJobSettlementPayloadV1["trip"] | undefined {
  if (!isRecord(value)) return undefined;
  const trip: NonNullable<AutoAcceptJobSettlementPayloadV1["trip"]> = {};
  const requestId = integerValue(value.request_id);
  const bookingId = integerValue(value.booking_id);
  const acceptanceStatus = integerValue(value.acceptance_status);
  const assignmentStatus = integerValue(value.assignment_status);
  const listAgeMs = integerValue(value.listAgeMs);
  if (requestId !== undefined) trip.request_id = requestId;
  if (bookingId !== undefined) trip.booking_id = bookingId;
  const origin = textValue(value.origin);
  const destination = textValue(value.destination);
  const route = textValue(value.route);
  const costType = textValue(value.cost_type);
  const tripType = textValue(value.trip_type);
  const shiftType = textValue(value.shift_type);
  const vehicleType = textValue(value.vehicle_type);
  const standbyDateTime = textValue(value.standby_datetime);
  const bookingName = textValue(value.booking_name);
  const agencyName = textValue(value.agency_name);
  if (origin) trip.origin = origin;
  if (destination) trip.destination = destination;
  if (route) trip.route = route;
  if (costType) trip.cost_type = costType;
  if (tripType) trip.trip_type = tripType;
  if (shiftType) trip.shift_type = shiftType;
  if (vehicleType) trip.vehicle_type = vehicleType;
  if (standbyDateTime) trip.standby_datetime = standbyDateTime;
  if (bookingName) trip.booking_name = bookingName;
  if (agencyName) trip.agency_name = agencyName;
  if (acceptanceStatus !== undefined) trip.acceptance_status = acceptanceStatus;
  if (assignmentStatus !== undefined) trip.assignment_status = assignmentStatus;
  if (listAgeMs !== undefined && listAgeMs >= 0) trip.listAgeMs = listAgeMs;
  return trip;
}

function readPayload(row: AutoAcceptJobRow): PayloadResult {
  const parsedResult = parsePayloadJson(row);
  if ("ok" in parsedResult) return parsedResult;
  const value = parsedResult.parsed;
  if (value.executionMode !== undefined && value.executionMode !== "shadow" && value.executionMode !== "cutover") {
    return invalidPayload("executionMode must be shadow or cutover");
  }
  if (value.schemaVersion !== 1) return invalidPayload("schemaVersion must be 1");
  if (!isNonEmptyString(value.idempotencyKey)) return invalidPayload("idempotencyKey must be non-empty");
  if (!isAttemptKind(value.attemptKind)) return invalidPayload("attemptKind is not supported");
  if (!isInteger(value.teamId)) return invalidPayload("teamId must be an integer");
  if (!isInteger(value.bookingId)) return invalidPayload("bookingId must be an integer");
  if (!isInteger(value.requestId)) return invalidPayload("requestId must be an integer");
  if (!isNonEmptyString(value.ruleId)) return invalidPayload("ruleId must be non-empty");
  if (!isNonEmptyString(value.ruleName)) return invalidPayload("ruleName must be non-empty");
  if (typeof value.acceptAll !== "boolean") return invalidPayload("acceptAll must be a boolean");
  if (!isSource(value.source)) return invalidPayload("source is not supported");
  if (!isNonEmptyString(value.observedAt)) return invalidPayload("observedAt must be non-empty");
  if (!isNonEmptyString(value.pollerNodeId)) return invalidPayload("pollerNodeId must be non-empty");
  if (!isAttemptKind(row.attemptKind)) return invalidPayload("job attemptKind is not supported");

  const payload: AutoAcceptJobSettlementPayloadV1 = {
    ...(value.executionMode === "shadow" || value.executionMode === "cutover" ? { executionMode: value.executionMode } : {}),
    ...(isNonEmptyString(value.cutoverEpoch) ? { cutoverEpoch: value.cutoverEpoch } : {}),
    schemaVersion: 1,
    idempotencyKey: value.idempotencyKey,
    attemptKind: value.attemptKind,
    teamId: value.teamId,
    bookingId: value.bookingId,
    requestId: value.requestId,
    ruleId: value.ruleId,
    ruleName: value.ruleName,
    acceptAll: value.acceptAll,
    source: value.source,
    ...(isRecord(value.trip) ? { trip: readTrip(value.trip) } : {}),
    observedAt: value.observedAt,
    pollerNodeId: value.pollerNodeId,
  };

  const expectedKey = buildAutoAcceptJobIdempotencyKey({
    ...(payload.executionMode ? { executionMode: payload.executionMode } : {}),
    ...(row.cutoverEpoch ? { cutoverEpoch: row.cutoverEpoch } : {}),
    teamId: row.teamId,
    bookingId: row.bookingId,
    requestId: row.requestId,
    ruleId: row.ruleId,
    attemptKind: row.attemptKind,
  });
  const mismatched = payload.idempotencyKey !== row.idempotencyKey ||
    (payload.cutoverEpoch ?? null) !== row.cutoverEpoch ||
    payload.idempotencyKey !== expectedKey ||
    payload.attemptKind !== row.attemptKind ||
    payload.teamId !== row.teamId ||
    payload.bookingId !== row.bookingId ||
    payload.requestId !== row.requestId ||
    payload.ruleId !== row.ruleId;
  if (mismatched) {
    return {
      ok: false,
      reasonCode: "settlement_identity_mismatch",
      error: "payload identity does not match durable job identity",
    };
  }

  if (payload.requestId <= 0) {
    return {
      ok: false,
      reasonCode: "settlement_request_id_required",
      error: "resume settlement currently requires a request-level job",
    };
  }

  return { ok: true, payload };
}

function statusForHistory(resultStatus: AutoAcceptJobResultStatus): AutoAcceptRecord["status"] {
  if (resultStatus === "owned") return "success";
  if (resultStatus === "unknown") return "indeterminate";
  return "failed";
}

function verificationStatusForHistory(resultStatus: AutoAcceptJobResultStatus): AutoAcceptRecord["verificationStatus"] {
  if (resultStatus === "owned") return "verified_success";
  if (resultStatus === "unknown") return "indeterminate";
  return "verified_failed";
}

function routeField(value: string | undefined): string {
  return value ?? "";
}

function buildHistoryRecord(input: {
  row: AutoAcceptJobRow;
  payload: AutoAcceptJobSettlementPayloadV1;
  resultStatus: AutoAcceptJobResultStatus;
  now: Date;
}): AutoAcceptRecord {
  const { row, payload, resultStatus, now } = input;
  const requestIds = [row.requestId];
  const status = statusForHistory(resultStatus);
  return {
    ruleId: row.ruleId,
    ruleName: payload.ruleName,
    bookingId: row.bookingId,
    requestIds,
    acceptedCount: resultStatus === "owned" ? requestIds.length : 0,
    origin: routeField(payload.trip?.origin),
    destination: routeField(payload.trip?.destination),
    vehicleType: routeField(payload.trip?.vehicle_type),
    status,
    ...(status === "failed" ? { failureReason: row.resultReasonCode === "verified_lost_race" ? "lost_race" : "verify_not_confirmed" } : {}),
    ...(status !== "success" ? { errorMessage: row.resultReasonCode ?? "auto-accept result was not owned" } : {}),
    traceId: row.winningAttemptTraceId,
    listAgeMs: payload.trip?.listAgeMs,
    verificationStatus: verificationStatusForHistory(resultStatus),
    verifiedAt: now,
  };
}

function routeForBookingHistory(input: {
  route?: string;
  origin?: string;
  destination?: string;
}): string | undefined {
  if (input.route) return input.route;
  if (input.origin && input.destination) return `${input.origin} -> ${input.destination}`;
  return undefined;
}

function buildBookingHistoryRecord(input: {
  row: AutoAcceptJobRow;
  payload: AutoAcceptJobSettlementPayloadV1;
  resultStatus: AutoAcceptJobResultStatus;
}): BookingHistoryRecord | undefined {
  const { row, payload, resultStatus } = input;
  if (resultStatus !== "owned") return undefined;
  if (payload.attemptKind !== "own_status_reconcile" || payload.source !== "reconciliation") return undefined;
  if (row.requestId <= 0) return undefined;
  const trip = payload.trip;
  if (!trip || trip.request_id !== row.requestId) return undefined;

  const origin = trip.origin;
  const destination = trip.destination;
  const route = routeForBookingHistory({ route: trip.route, origin, destination });
  const costType = trip.cost_type;
  const tripType = trip.trip_type;
  const shiftType = trip.shift_type;
  const vehicleType = trip.vehicle_type;
  const standbyDateTime = trip.standby_datetime;

  if (!route || !origin || !destination || !costType || !tripType || !shiftType || !vehicleType || !standbyDateTime) {
    return undefined;
  }

  return {
    requestId: row.requestId,
    bookingId: trip.booking_id ?? row.bookingId,
    bookingName: trip.booking_name,
    agencyName: trip.agency_name,
    route,
    origin,
    destination,
    costType,
    tripType,
    shiftType,
    vehicleType,
    standbyDateTime,
    acceptanceStatus: trip.acceptance_status,
    assignmentStatus: trip.assignment_status,
  };
}

function buildNotificationMessage(input: {
  payload: AutoAcceptJobSettlementPayloadV1;
  requestIds: number[];
}): string {
  const route = [input.payload.trip?.origin, input.payload.trip?.destination]
    .filter((value): value is string => Boolean(value))
    .join(" -> ");
  return [
    `SPX Auto-Accept สำเร็จ ${input.requestIds.length} รายการ`,
    `booking_id=${input.payload.bookingId}`,
    `requests=[${input.requestIds.join(",")}]`,
    route ? `route=${route}` : "",
    input.payload.trip?.vehicle_type ? `vehicle=${input.payload.trip.vehicle_type}` : "",
  ].filter(Boolean).join("\n");
}

function resolveTeamName(
  teamId: number,
  teamName: CreateAutoAcceptJobSettlementOperationsOptions["teamName"],
): string {
  if (typeof teamName === "function") return teamName(teamId);
  if (typeof teamName === "string" && teamName.trim().length > 0) return teamName.trim();
  return `Team ${teamId}`;
}

function retry(input: {
  reasonCode: string;
  error: unknown;
  retryDelayMs: number;
}): AutoAcceptJobExecutionResult {
  return {
    outcome: "retry",
    reasonCode: input.reasonCode,
    error: errorMessage(input.error),
    retryDelayMs: input.retryDelayMs,
    count: "verify",
  };
}

async function checkpointSettlement(
  context: AutoAcceptJobExecutionContext,
  checkpoint: Parameters<AutoAcceptJobExecutionContext["checkpointSettlement"]>[0],
): Promise<AutoAcceptJobExecutionResult | null> {
  const checkpointed = await context.checkpointSettlement(checkpoint);
  if (checkpointed) return null;
  return retry({
    reasonCode: "settlement_checkpoint_failed",
    error: "settlement checkpoint could not be written",
    retryDelayMs: DEFAULT_SETTLEMENT_RETRY_DELAY_MS,
  });
}

function settlementClaimLost(retryDelayMs: number): AutoAcceptJobExecutionResult {
  return retry({
    reasonCode: "settlement_claim_lost",
    error: "settlement claim was lost before side effect",
    retryDelayMs,
  });
}

export async function settleAutoAcceptJobFromCheckpoint(
  context: AutoAcceptJobExecutionContext,
  options: AutoAcceptJobSettlementOptions,
): Promise<AutoAcceptJobExecutionResult> {
  const { row } = context;
  const payloadResult = readPayload(row);
  if (!payloadResult.ok) {
    if (payloadResult.retryable) {
      return {
        outcome: "retry",
        reasonCode: payloadResult.reasonCode,
        error: payloadResult.error,
        retryDelayMs: options.retryDelayMsOnSettlementError ?? DEFAULT_SETTLEMENT_RETRY_DELAY_MS,
        count: "verify",
      };
    }
    return {
      outcome: "dead_letter",
      reasonCode: payloadResult.reasonCode,
      error: payloadResult.error,
    };
  }

  const admissionRejection = rejectUnadmittedAutoAcceptJob(payloadResult.payload.executionMode);
  if (admissionRejection) return admissionRejection;
  try {
    await assertJobPublicationCurrent(row);
  } catch (error) {
    if (errorMessage(error) === "stale publication epoch") {
      return { outcome: "indeterminate", reasonCode: "settlement_publication_not_current", preserveEvidence: true };
    }
    return retry({ reasonCode: "publication_control_unavailable", error: "publication control could not be read",
      retryDelayMs: options.retryDelayMsOnSettlementError ?? DEFAULT_SETTLEMENT_RETRY_DELAY_MS });
  }

  if (!row.resultStatus || !row.resultReasonCode) {
    return retry({
      reasonCode: "settlement_missing_canonical_result",
      error: "auto_accept_jobs row has no canonical result checkpoint",
      retryDelayMs: options.retryDelayMsOnSettlementError ?? DEFAULT_SETTLEMENT_RETRY_DELAY_MS,
    });
  }

  const payload = payloadResult.payload;
  const requestIds = [row.requestId];
  const resultStatus = row.resultStatus as AutoAcceptJobResultStatus;
  const bookingHistoryRecord = buildBookingHistoryRecord({ row, payload, resultStatus });
  const retryDelayMs = options.retryDelayMsOnSettlementError ?? DEFAULT_SETTLEMENT_RETRY_DELAY_MS;

  let progressSettledAt = row.progressSettledAt;
  let historyWrittenAt = row.historyWrittenAt;
  let notificationEnqueuedAt = row.notificationEnqueuedAt;

  if (resultStatus === "owned" && !progressSettledAt) {
    if (!await context.renewClaim()) return settlementClaimLost(retryDelayMs);
    try {
      await options.operations.settleProgress({
        jobId: row.id,
        teamId: row.teamId,
        bookingId: row.bookingId,
        requestIds,
        ruleId: row.ruleId,
        acceptedCount: requestIds.length,
        traceId: row.winningAttemptTraceId,
        reasonCode: row.resultReasonCode,
      });
    } catch (error) {
      return retry({ reasonCode: "progress_settlement_failed", error, retryDelayMs });
    }
    progressSettledAt = context.currentTime();
    const checkpointError = await checkpointSettlement(context, { progressSettledAt });
    if (checkpointError) return checkpointError;
  }

  if (!historyWrittenAt) {
    if (!await context.renewClaim()) return settlementClaimLost(retryDelayMs);
    const historyBoundaryAt = context.currentTime();
    try {
      await options.operations.writeHistory({
        jobId: row.id,
        teamId: row.teamId,
        record: buildHistoryRecord({ row, payload, resultStatus, now: historyBoundaryAt }),
        ...(bookingHistoryRecord ? { bookingHistoryRecord } : {}),
      });
    } catch (error) {
      return retry({ reasonCode: "history_settlement_failed", error, retryDelayMs });
    }
    historyWrittenAt = context.currentTime();
    const checkpointError = await checkpointSettlement(context, { historyWrittenAt });
    if (checkpointError) return checkpointError;
  }

  if (resultStatus === "owned" && !notificationEnqueuedAt) {
    if (!await context.renewClaim()) return settlementClaimLost(retryDelayMs);
    try {
      await options.operations.enqueueNotification({
        jobId: row.id,
        teamId: row.teamId,
        bookingId: row.bookingId,
        requestIds,
        ruleId: row.ruleId,
        ruleName: payload.ruleName,
        traceId: row.winningAttemptTraceId,
        message: buildNotificationMessage({ payload, requestIds }),
        evidence: {
          reasonCode: row.resultReasonCode,
          source: payload.source,
          attemptKind: payload.attemptKind,
        },
      });
    } catch (error) {
      return retry({ reasonCode: "notification_settlement_failed", error, retryDelayMs });
    }
    notificationEnqueuedAt = context.currentTime();
    const checkpointError = await checkpointSettlement(context, { notificationEnqueuedAt });
    if (checkpointError) return checkpointError;
  }

  if (resultStatus === "owned") {
    return {
      outcome: "succeeded",
      resultStatus: "owned",
      reasonCode: row.resultReasonCode,
      winningAttemptTraceId: row.winningAttemptTraceId,
      progressSettledAt,
      historyWrittenAt,
      notificationEnqueuedAt,
    };
  }

  return {
    outcome: resultStatus === "unknown" ? "indeterminate" : "failed",
    resultStatus,
    reasonCode: row.resultReasonCode,
    winningAttemptTraceId: row.winningAttemptTraceId,
  };
}

export function createAutoAcceptJobSettlementOperations(
  options: CreateAutoAcceptJobSettlementOperationsOptions = {},
): AutoAcceptJobSettlementOperations {
  const publisher = options.publisher ?? createWorkerNotificationPublisher();
  return {
    async settleProgress(input) {
      const result = await settleAutoAcceptProgressOnce(input);
      if (!result.duplicate) {
        await refreshRulesAfterAutoAcceptSettlement(input.teamId);
      }
    },
    async writeHistory(input) {
      const result = await writeAutoAcceptHistoryOnce({
        jobId: input.jobId,
        teamId: input.teamId,
        record: input.record,
      });
      if (!result.duplicate && result.historyId === null) {
        throw new Error("auto_accept_history insert did not return an id");
      }
      if (input.bookingHistoryRecord) {
        await insertBookingHistory(input.teamId, input.bookingHistoryRecord);
      }
    },
    async enqueueNotification(input) {
      const published = await publisher.autoAcceptOwned({
        teamId: input.teamId,
        teamName: resolveTeamName(input.teamId, options.teamName),
        bookingId: input.bookingId,
        requestIds: input.requestIds,
        traceId: input.traceId ?? undefined,
        message: input.message,
        evidence: input.evidence,
      });
      if (!published.ok) throw new Error(published.error ?? "notification publish failed");
    },
  };
}

export function runAutoAcceptJobSettlementBatch(
  input: RunAutoAcceptJobSettlementBatchInput,
): Promise<AutoAcceptWorkerBatchResult> {
  return runAutoAcceptWorkerBatch({
    ...input,
    claimScope: "settlement",
    execute: (context) => settleAutoAcceptJobFromCheckpoint(context, input),
  });
}
