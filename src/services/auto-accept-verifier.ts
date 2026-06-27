import type { ApiClient } from "./api-client.js";
import type { BookingRequestListResponse } from "../models/types.js";
import type { ClaimToken } from "./notifier.js";
import type { TripLike } from "./notify-rules.js";
import {
  type AutoAcceptEvidence,
  type AutoAcceptFailureReason,
  type VerificationStatus,
} from "./auto-accept-diagnostics.js";

export interface AutoAcceptVerificationJob {
  teamId: number;
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  trips: TripLike[];
  claimToken: ClaimToken;
  acceptResult: {
    ok: boolean;
    httpStatus: number;
    retcode?: number;
    message?: string;
    error?: string;
  };
  acceptStartedAt: number;
  acceptFinishedAt: number;
  acceptRttMs: number;
  listAgeMs?: number;
  ambiguousAccept: boolean;
  acceptAll: boolean;
  traceId: string;
}

export interface AutoAcceptVerifiedRequest {
  requestId: number;
  status: "accepted" | "failed" | "indeterminate";
  reason?: AutoAcceptFailureReason;
  observedStatus: number | null;
  terminal: boolean;
  releaseRequestDedupe: boolean;
  releaseBudget: boolean;
}

export interface AutoAcceptVerificationOutcome {
  job: AutoAcceptVerificationJob;
  verificationStatus: VerificationStatus;
  acceptedRequestIds: number[];
  failedRequestIds: number[];
  indeterminateRequestIds: number[];
  requests: AutoAcceptVerifiedRequest[];
  evidence: AutoAcceptEvidence;
}

export interface VerifyAutoAcceptOptions {
  ambiguousRecheckDelayMs?: number;
}

const DEFAULT_AMBIGUOUS_VERIFY_RECHECK_DELAY_MS = 2_500;
const ACCEPTED_STATUS = 2;
const LOST_RACE_STATUSES = new Set<number>([4]);
const UNPROVEN_OWNERSHIP_STATUSES = new Set<number>([6]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionExpired(result: AutoAcceptVerificationJob["acceptResult"]): boolean {
  const text = `${result.retcode ?? ""} ${result.message ?? ""} ${result.error ?? ""}`.toLowerCase();
  return result.httpStatus === 401
    || result.httpStatus === 403
    || text.includes("session")
    || text.includes("cookie")
    || text.includes("unauthor");
}

function nextActionFor(reason: AutoAcceptFailureReason): string {
  switch (reason) {
    case "lost_race":
      return "Check accept RTT and list age; SPX shows another agency reached the request first.";
    case "session_expired":
      return "Refresh the SPX cookie/device credentials for this team.";
    case "accept_timeout_ambiguous":
      return "No final failure yet; the verifier will leave quota conservative and later polling may reconcile.";
    case "verify_indeterminate":
      return "Verification could not read SPX tabs; retry/reconcile before treating this as a loss.";
    case "verify_not_confirmed":
      return "SPX tabs were readable but did not prove our ownership.";
    case "accept_api_error":
      return "Inspect the SPX accept API response and current session health.";
    case "rule_budget_exhausted":
      return "Review rule need and in-flight auto-accept claims.";
    case "request_deduped":
      return "Request is already in-flight or was terminal in this process.";
  }
}

async function readTabs(apiClient: ApiClient, bookingId: number): Promise<{
  pendingList: BookingRequestListResponse | null;
  confirmedList: BookingRequestListResponse | null;
  pendingTabRead: boolean;
  confirmedTabRead: boolean;
}> {
  const [pendingResult, confirmedResult] = await Promise.allSettled([
    apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: true }),
    apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: false }),
  ]);

  const pendingList = pendingResult.status === "fulfilled" ? pendingResult.value : null;
  const confirmedList = confirmedResult.status === "fulfilled" ? confirmedResult.value : null;

  return {
    pendingList,
    confirmedList,
    pendingTabRead: Boolean(pendingList),
    confirmedTabRead: Boolean(confirmedList),
  };
}

function mergeStatuses(lists: Array<BookingRequestListResponse | null>): Map<number, number> {
  const merged = new Map<number, number>();
  for (const list of lists) {
    if (!list) continue;
    for (const request of list.data.request_list) {
      const previous = merged.get(request.request_id);
      if (previous === undefined || request.request_acceptance_status > previous) {
        merged.set(request.request_id, request.request_acceptance_status);
      }
    }
  }
  return merged;
}

function requestFor(reason: AutoAcceptFailureReason, requestId: number, observedStatus: number | null): AutoAcceptVerifiedRequest {
  if (reason === "verify_indeterminate" || reason === "accept_timeout_ambiguous") {
    return {
      requestId,
      status: "indeterminate",
      reason,
      observedStatus,
      terminal: false,
      releaseRequestDedupe: true,
      releaseBudget: false,
    };
  }
  if (reason === "session_expired" || reason === "accept_api_error") {
    return {
      requestId,
      status: "failed",
      reason,
      observedStatus,
      terminal: false,
      releaseRequestDedupe: true,
      releaseBudget: true,
    };
  }
  return {
    requestId,
    status: "failed",
    reason,
    observedStatus,
    terminal: true,
    releaseRequestDedupe: false,
    releaseBudget: true,
  };
}

function classifyRequest(
  job: AutoAcceptVerificationJob,
  requestId: number,
  observedStatus: number | null,
): AutoAcceptVerifiedRequest {
  if (observedStatus === ACCEPTED_STATUS) {
    return {
      requestId,
      status: "accepted",
      observedStatus,
      terminal: true,
      releaseRequestDedupe: false,
      releaseBudget: false,
    };
  }

  if (job.ambiguousAccept) return requestFor("accept_timeout_ambiguous", requestId, observedStatus);
  if (isSessionExpired(job.acceptResult)) return requestFor("session_expired", requestId, observedStatus);
  if (!job.acceptResult.ok) return requestFor("accept_api_error", requestId, observedStatus);
  if (observedStatus !== null && LOST_RACE_STATUSES.has(observedStatus)) return requestFor("lost_race", requestId, observedStatus);
  if (observedStatus !== null && UNPROVEN_OWNERSHIP_STATUSES.has(observedStatus)) return requestFor("verify_not_confirmed", requestId, observedStatus);
  return requestFor("verify_not_confirmed", requestId, observedStatus);
}

function buildOutcome(
  job: AutoAcceptVerificationJob,
  tabRead: { pendingTabRead: boolean; confirmedTabRead: boolean },
  statuses: Map<number, number>,
  requests: AutoAcceptVerifiedRequest[],
  verificationLatencyMs: number,
): AutoAcceptVerificationOutcome {
  const acceptedRequestIds = requests.filter((request) => request.status === "accepted").map((request) => request.requestId);
  const failedRequestIds = requests.filter((request) => request.status === "failed").map((request) => request.requestId);
  const indeterminateRequestIds = requests.filter((request) => request.status === "indeterminate").map((request) => request.requestId);
  const firstReason = requests.find((request) => request.reason)?.reason;
  const verificationStatus: VerificationStatus = acceptedRequestIds.length > 0
    ? "verified_success"
    : indeterminateRequestIds.length > 0
      ? "indeterminate"
      : "verified_failed";

  const observedStatuses: Record<number, number | null> = {};
  for (const requestId of job.requestIds) observedStatuses[requestId] = statuses.get(requestId) ?? null;

  const evidence: AutoAcceptEvidence = {
    traceId: job.traceId,
    ...(firstReason ? { reason: firstReason } : {}),
    verificationStatus,
    acceptRttMs: job.acceptRttMs,
    ...(typeof job.listAgeMs === "number" ? { listAgeMs: job.listAgeMs } : {}),
    verificationLatencyMs,
    pendingTabRead: tabRead.pendingTabRead,
    confirmedTabRead: tabRead.confirmedTabRead,
    observedStatuses,
    nextAction: firstReason ? nextActionFor(firstReason) : "Verified SPX ownership.",
  };

  return {
    job,
    verificationStatus,
    acceptedRequestIds,
    failedRequestIds,
    indeterminateRequestIds,
    requests,
    evidence,
  };
}

export async function verifyAutoAcceptJob(
  apiClient: ApiClient,
  job: AutoAcceptVerificationJob,
  options: VerifyAutoAcceptOptions = {},
): Promise<AutoAcceptVerificationOutcome> {
  const startedAt = Date.now();
  let tabRead = await readTabs(apiClient, job.bookingId);
  let statuses = mergeStatuses([tabRead.pendingList, tabRead.confirmedList]);

  if (job.ambiguousAccept && !job.requestIds.some((requestId) => statuses.get(requestId) === ACCEPTED_STATUS)) {
    await sleep(options.ambiguousRecheckDelayMs ?? DEFAULT_AMBIGUOUS_VERIFY_RECHECK_DELAY_MS);
    tabRead = await readTabs(apiClient, job.bookingId);
    statuses = mergeStatuses([tabRead.pendingList, tabRead.confirmedList]);
  }

  const verificationLatencyMs = Date.now() - startedAt;
  if (!tabRead.pendingTabRead && !tabRead.confirmedTabRead) {
    const requests = job.requestIds.map((requestId) => requestFor("verify_indeterminate", requestId, null));
    return buildOutcome(job, tabRead, statuses, requests, verificationLatencyMs);
  }

  const requests = job.requestIds.map((requestId) => {
    const observedStatus = statuses.get(requestId) ?? null;
    return classifyRequest(job, requestId, observedStatus);
  });

  return buildOutcome(job, tabRead, statuses, requests, verificationLatencyMs);
}
