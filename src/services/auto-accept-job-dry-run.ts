import {
  buildAutoAcceptJobIdempotencyKey,
  type AutoAcceptAttemptKind,
  type AutoAcceptJobExecutionMode,
  type AutoAcceptJobRow,
} from "../repositories/auto-accept-job-repository.js";
import {
  runAutoAcceptWorkerBatch,
  type AutoAcceptJobExecutor,
  type AutoAcceptWorkerBatchResult,
  type RunAutoAcceptWorkerBatchInput,
} from "./auto-accept-worker.js";

export type AutoAcceptDryRunReasonCode =
  | "dry_run_validated"
  | "dry_run_invalid_payload_json"
  | "dry_run_invalid_payload"
  | "dry_run_identity_mismatch"
  | "dry_run_attempt_source_mismatch"
  | "dry_run_forbidden_payload_key"
  | "dry_run_rule_missing"
  | "dry_run_rule_inactive"
  | "dry_run_rule_state_mismatch"
  | "dry_run_rule_state_unavailable";

export interface AutoAcceptDryRunRuleState {
  need: number;
  accept_all: boolean;
  enabled: boolean;
  fulfilled: boolean;
}

export interface AutoAcceptDryRunPayloadV1 {
  executionMode?: AutoAcceptJobExecutionMode;
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
  trip?: Record<string, unknown>;
  ruleSnapshot: AutoAcceptDryRunRuleState;
  observedAt: string;
  firstMatchedAtMs?: number;
  pollerNodeId: string;
  cutoverEpoch?: string;
  pollerLeaseOwnerId?: string;
  bookingName?: string;
  bookingCreatedAtMs?: number;
  traceParent?: string;
}

export type AutoAcceptDryRunValidationResult =
  | {
      ok: true;
      payload: AutoAcceptDryRunPayloadV1;
      ruleState: AutoAcceptDryRunRuleState;
    }
  | {
      ok: false;
      reasonCode: Exclude<AutoAcceptDryRunReasonCode, "dry_run_validated">;
      error: string;
      retryable?: boolean;
    };

export type AutoAcceptDryRunStructuralValidationResult =
  | {
      ok: true;
      payload: AutoAcceptDryRunPayloadV1;
    }
  | AutoAcceptDryRunValidationFailure;

type AutoAcceptDryRunValidationFailure = Extract<AutoAcceptDryRunValidationResult, { ok: false }>;

type ParsedPayloadJsonResult =
  | { parsed: Record<string, unknown> }
  | AutoAcceptDryRunValidationFailure;

type ReadPayloadResult =
  | { payload: AutoAcceptDryRunPayloadV1 }
  | AutoAcceptDryRunValidationFailure;

export type AutoAcceptDryRunRuleStateLoader = (input: {
  row: AutoAcceptJobRow;
  payload: AutoAcceptDryRunPayloadV1;
}) => Promise<AutoAcceptDryRunRuleState | null> | AutoAcceptDryRunRuleState | null;

export interface AutoAcceptJobDryRunOptions {
  loadRuleState?: AutoAcceptDryRunRuleStateLoader;
  retryDelayMsOnRuleStateError?: number;
}

export interface RunAutoAcceptJobDryRunBatchInput extends Omit<RunAutoAcceptWorkerBatchInput, "execute"> {
  loadRuleState?: AutoAcceptDryRunRuleStateLoader;
  retryDelayMsOnRuleStateError?: number;
}

const DEFAULT_RULE_STATE_RETRY_DELAY_MS = 30_000;

const attemptKinds = new Set<AutoAcceptAttemptKind>([
  "pending_request",
  "non_pending_probe",
  "fast_accept_all",
  "own_status_reconcile",
]);

const expectedSourceByAttemptKind: Record<AutoAcceptAttemptKind, AutoAcceptDryRunPayloadV1["source"]> = {
  pending_request: "pending_tab",
  non_pending_probe: "non_pending_tab",
  fast_accept_all: "booking_name",
  own_status_reconcile: "reconciliation",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAttemptKind(value: unknown): value is AutoAcceptAttemptKind {
  return typeof value === "string" && attemptKinds.has(value as AutoAcceptAttemptKind);
}

function isSource(value: unknown): value is AutoAcceptDryRunPayloadV1["source"] {
  return value === "pending_tab" ||
    value === "non_pending_tab" ||
    value === "booking_name" ||
    value === "reconciliation";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function invalidPayload(error: string): AutoAcceptDryRunValidationFailure {
  return { ok: false, reasonCode: "dry_run_invalid_payload", error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePayloadJson(row: AutoAcceptJobRow): ParsedPayloadJsonResult {
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (!isRecord(parsed)) return invalidPayload("payload must be a JSON object");
    return { parsed };
  } catch {
    return {
      ok: false,
      reasonCode: "dry_run_invalid_payload_json",
      error: "payloadJson is not valid JSON",
    };
  }
}

function readRuleState(value: unknown): AutoAcceptDryRunRuleState | null {
  if (!isRecord(value)) return null;
  if (!isInteger(value.need)) return null;
  if (typeof value.accept_all !== "boolean") return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.fulfilled !== "boolean") return null;
  return {
    need: value.need,
    accept_all: value.accept_all,
    enabled: value.enabled,
    fulfilled: value.fulfilled,
  };
}

function readPayload(value: Record<string, unknown>): ReadPayloadResult {
  if (value.executionMode !== undefined && value.executionMode !== "shadow" && value.executionMode !== "cutover") {
    return invalidPayload("executionMode must be shadow or cutover");
  }
  const ruleSnapshot = readRuleState(value.ruleSnapshot);
  if (!ruleSnapshot) return invalidPayload("ruleSnapshot must contain need, accept_all, enabled, and fulfilled");
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

  return {
    payload: {
      ...(value.executionMode === "shadow" || value.executionMode === "cutover" ? { executionMode: value.executionMode } : {}),
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
      ...(isRecord(value.trip) ? { trip: value.trip } : {}),
      ruleSnapshot,
      observedAt: value.observedAt,
      ...(typeof value.firstMatchedAtMs === "number" && Number.isFinite(value.firstMatchedAtMs) && value.firstMatchedAtMs >= 0
        ? { firstMatchedAtMs: value.firstMatchedAtMs } : {}),
      pollerNodeId: value.pollerNodeId,
      ...(isNonEmptyString(value.cutoverEpoch) ? { cutoverEpoch: value.cutoverEpoch } : {}),
      ...(isNonEmptyString(value.pollerLeaseOwnerId) ? { pollerLeaseOwnerId: value.pollerLeaseOwnerId } : {}),
      ...(isNonEmptyString(value.bookingName) ? { bookingName: value.bookingName } : {}),
      ...(typeof value.bookingCreatedAtMs === "number" ? { bookingCreatedAtMs: value.bookingCreatedAtMs } : {}),
      ...(isNonEmptyString(value.traceParent) ? { traceParent: value.traceParent } : {}),
    },
  };
}

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("cookie") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized === "authorization" ||
    normalized === "authheader" ||
    normalized === "authtoken" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "spxdeviceid" ||
    normalized === "deviceid" ||
    (normalized.startsWith("line") && (normalized.endsWith("id") || normalized.includes("token")));
}

function findForbiddenPayloadKey(value: unknown, path = "payload"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findForbiddenPayloadKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenPayloadKey(key)) return childPath;
    const found = findForbiddenPayloadKey(child, childPath);
    if (found) return found;
  }
  return null;
}

function validateIdentity(row: AutoAcceptJobRow, payload: AutoAcceptDryRunPayloadV1): AutoAcceptDryRunValidationResult | null {
  if (row.schemaVersion !== 1) return invalidPayload("job schemaVersion must be 1");
  if (!isAttemptKind(row.attemptKind)) return invalidPayload("job attemptKind is not supported");
  const expectedKey = buildAutoAcceptJobIdempotencyKey({
    ...(payload.executionMode ? { executionMode: payload.executionMode } : {}),
    teamId: row.teamId,
    ...(row.cutoverEpoch ? { cutoverEpoch: row.cutoverEpoch } : {}),
    bookingId: row.bookingId,
    requestId: row.requestId,
    ruleId: row.ruleId,
    attemptKind: row.attemptKind,
  });
  const mismatched = payload.idempotencyKey !== row.idempotencyKey ||
    payload.idempotencyKey !== expectedKey ||
    (payload.cutoverEpoch ?? null) !== row.cutoverEpoch ||
    payload.attemptKind !== row.attemptKind ||
    payload.teamId !== row.teamId ||
    payload.bookingId !== row.bookingId ||
    payload.requestId !== row.requestId ||
    payload.ruleId !== row.ruleId;
  if (!mismatched) return null;
  return {
    ok: false,
    reasonCode: "dry_run_identity_mismatch",
    error: "payload identity does not match durable job identity",
  };
}

function validateAttemptSource(payload: AutoAcceptDryRunPayloadV1): AutoAcceptDryRunValidationResult | null {
  const expectedSource = expectedSourceByAttemptKind[payload.attemptKind];
  if (payload.source !== expectedSource) {
    return {
      ok: false,
      reasonCode: "dry_run_attempt_source_mismatch",
      error: `attemptKind ${payload.attemptKind} requires source ${expectedSource}`,
    };
  }

  if (payload.attemptKind === "fast_accept_all") {
    if (payload.requestId === 0 && payload.acceptAll === true && isNonEmptyString(payload.bookingName)) return null;
    return {
      ok: false,
      reasonCode: "dry_run_attempt_source_mismatch",
      error: "fast_accept_all requires requestId=0, acceptAll=true, and bookingName",
    };
  }

  if (payload.requestId > 0 && payload.acceptAll === false) return null;
  return {
    ok: false,
    reasonCode: "dry_run_attempt_source_mismatch",
    error: `${payload.attemptKind} requires requestId > 0 and acceptAll=false`,
  };
}

function validateTripEvidence(payload: AutoAcceptDryRunPayloadV1): AutoAcceptDryRunValidationResult | null {
  if (!payload.trip) return null;
  const requestId = payload.trip.request_id;
  if (typeof requestId === "number" && payload.requestId > 0 && requestId !== payload.requestId) {
    return {
      ok: false,
      reasonCode: "dry_run_identity_mismatch",
      error: "trip request_id does not match durable job requestId",
    };
  }

  const bookingId = payload.trip.booking_id;
  if (typeof bookingId === "number" && bookingId > 0 && bookingId !== payload.bookingId) {
    return {
      ok: false,
      reasonCode: "dry_run_identity_mismatch",
      error: "trip booking_id does not match durable job bookingId",
    };
  }

  return null;
}

function validateRuleState(payload: AutoAcceptDryRunPayloadV1, ruleState: AutoAcceptDryRunRuleState): AutoAcceptDryRunValidationResult | null {
  if (!ruleState.enabled || ruleState.fulfilled || ruleState.need <= 0) {
    return {
      ok: false,
      reasonCode: "dry_run_rule_inactive",
      error: "rule is disabled, fulfilled, or has no remaining need",
    };
  }

  if (ruleState.accept_all !== payload.acceptAll && payload.attemptKind !== "own_status_reconcile") {
    return {
      ok: false,
      reasonCode: "dry_run_rule_state_mismatch",
      error: "rule accept_all does not match payload acceptAll",
    };
  }

  return null;
}

export async function validateAutoAcceptJobDryRunPayload(
  row: AutoAcceptJobRow,
  options: AutoAcceptJobDryRunOptions = {},
): Promise<AutoAcceptDryRunValidationResult> {
  const structural = validateAutoAcceptJobDryRunPayloadStructure(row);
  if (!structural.ok) return structural;
  return await validateAutoAcceptJobDryRunRuleState(row, structural.payload, options);
}

export function validateAutoAcceptJobDryRunPayloadStructure(
  row: AutoAcceptJobRow,
): AutoAcceptDryRunStructuralValidationResult {
  const parsed = parsePayloadJson(row);
  if (!("parsed" in parsed)) return parsed;
  const forbiddenKey = findForbiddenPayloadKey(parsed.parsed);
  if (forbiddenKey) {
    return {
      ok: false,
      reasonCode: "dry_run_forbidden_payload_key",
      error: `${forbiddenKey} is not allowed in auto_accept_jobs payload`,
    };
  }

  const payloadResult = readPayload(parsed.parsed);
  if (!("payload" in payloadResult)) return payloadResult;
  const { payload } = payloadResult;

  const identityValidation = validateIdentity(row, payload);
  if (identityValidation) return identityValidation;

  const attemptValidation = validateAttemptSource(payload);
  if (attemptValidation) return attemptValidation;

  const tripValidation = validateTripEvidence(payload);
  if (tripValidation) return tripValidation;

  return { ok: true, payload };
}

export async function validateAutoAcceptJobDryRunRuleState(
  row: AutoAcceptJobRow,
  payload: AutoAcceptDryRunPayloadV1,
  options: AutoAcceptJobDryRunOptions = {},
): Promise<AutoAcceptDryRunValidationResult> {
  let loadedRuleState: AutoAcceptDryRunRuleState | null;
  try {
    loadedRuleState = options.loadRuleState
      ? await options.loadRuleState({ row, payload })
      : payload.ruleSnapshot;
  } catch (error) {
    return {
      ok: false,
      reasonCode: "dry_run_rule_state_unavailable",
      error: errorMessage(error),
      retryable: true,
    };
  }
  if (!loadedRuleState) {
    return {
      ok: false,
      reasonCode: "dry_run_rule_missing",
      error: "rule state was not found",
    };
  }
  const ruleValidation = validateRuleState(payload, loadedRuleState);
  if (ruleValidation) return ruleValidation;

  return {
    ok: true,
    payload,
    ruleState: loadedRuleState,
  };
}

export function createAutoAcceptJobDryRunExecutor(
  options: AutoAcceptJobDryRunOptions = {},
): AutoAcceptJobExecutor {
  return async ({ row }) => {
    const validation = await validateAutoAcceptJobDryRunPayload(row, options);
    if (!validation.ok) {
      if (validation.retryable) {
        return {
          outcome: "retry",
          reasonCode: validation.reasonCode,
          error: validation.error,
          retryDelayMs: options.retryDelayMsOnRuleStateError ?? DEFAULT_RULE_STATE_RETRY_DELAY_MS,
          count: "verify",
        };
      }

      return {
        outcome: "dead_letter",
        reasonCode: validation.reasonCode,
        error: validation.error,
      };
    }

    return {
      outcome: "cancelled",
      resultStatus: "unknown",
      reasonCode: "dry_run_validated",
    };
  };
}

export async function runAutoAcceptJobDryRunBatch(
  input: RunAutoAcceptJobDryRunBatchInput,
): Promise<AutoAcceptWorkerBatchResult> {
  const { loadRuleState, retryDelayMsOnRuleStateError, ...workerInput } = input;
  return await runAutoAcceptWorkerBatch({
    ...workerInput,
    execute: createAutoAcceptJobDryRunExecutor({
      loadRuleState,
      retryDelayMsOnRuleStateError,
    }),
  });
}
