export const AUTO_ACCEPT_FAILURE_REASONS = [
  "lost_race",
  "session_expired",
  "accept_api_error",
  "accept_timeout_ambiguous",
  "verify_indeterminate",
  "verify_not_confirmed",
  "rule_budget_exhausted",
  "request_deduped",
] as const;

export type AutoAcceptFailureReason = typeof AUTO_ACCEPT_FAILURE_REASONS[number];
export type AutoAcceptHistoryStatus = "success" | "failed" | "indeterminate";
export type VerificationStatus = "verified_success" | "verified_failed" | "indeterminate";

export interface AutoAcceptEvidence {
  traceId: string;
  reason?: AutoAcceptFailureReason;
  verificationStatus: VerificationStatus;
  acceptRttMs?: number;
  listAgeMs?: number;
  verificationLatencyMs?: number;
  pendingTabRead: boolean;
  confirmedTabRead: boolean;
  observedStatuses: Record<number, number | null>;
  nextAction: string;
}

export function buildAutoAcceptTraceId(input: {
  teamId: number;
  bookingId: number;
  requestIds: number[];
  acceptStartedAt: number;
}): string {
  const ids = input.requestIds.join("-");
  return `aa:${input.teamId}:${input.bookingId}:${ids}:${input.acceptStartedAt}`;
}

export function summarizeAutoAcceptEvidence(evidence: AutoAcceptEvidence): string {
  const statuses = Object.entries(evidence.observedStatuses)
    .map(([requestId, status]) => `${requestId}:${status ?? "missing"}`)
    .join(",");
  return [
    `trace=${evidence.traceId}`,
    evidence.reason ? `reason=${evidence.reason}` : "",
    `verify=${evidence.verificationStatus}`,
    typeof evidence.acceptRttMs === "number" ? `acceptRttMs=${evidence.acceptRttMs}` : "",
    typeof evidence.listAgeMs === "number" ? `listAgeMs=${evidence.listAgeMs}` : "",
    typeof evidence.verificationLatencyMs === "number" ? `verificationLatencyMs=${evidence.verificationLatencyMs}` : "",
    `tabs=pending:${evidence.pendingTabRead ? "read" : "missing"},confirmed:${evidence.confirmedTabRead ? "read" : "missing"}`,
    statuses ? `statuses=${statuses}` : "",
    `next=${evidence.nextAction}`,
  ].filter(Boolean).join("; ");
}

export function buildAutoAcceptFailureAlertText(input: {
  now: Date;
  failures: Array<{
    bookingId: number;
    requestIds: number[];
    ruleName?: string;
    route?: string;
    vehicleType?: string;
    reason: AutoAcceptFailureReason;
    error: string;
    traceId?: string;
    acceptRttMs?: number;
    listAgeMs?: number;
    pendingTabRead?: boolean;
    confirmedTabRead?: boolean;
    nextAction?: string;
  }>;
}): string {
  const failLines = input.failures.map((failure) => {
    const tabEvidence = `pending=${failure.pendingTabRead ? "read" : "missing"}, confirmed=${failure.confirmedTabRead ? "read" : "missing"}`;
    return [
      `booking_id=${failure.bookingId} requests=[${failure.requestIds.join(",")}]`,
      `reason=${failure.reason}`,
      failure.ruleName ? `rule=${failure.ruleName}` : "",
      failure.route ? `route=${failure.route}` : "",
      failure.vehicleType ? `vehicle=${failure.vehicleType}` : "",
      typeof failure.acceptRttMs === "number" ? `acceptRttMs=${failure.acceptRttMs}` : "",
      typeof failure.listAgeMs === "number" ? `listAgeMs=${failure.listAgeMs}` : "",
      `tabs=${tabEvidence}`,
      failure.traceId ? `trace=${failure.traceId}` : "",
      `error=${failure.error}`,
      failure.nextAction ? `next=${failure.nextAction}` : "",
    ].filter(Boolean).join("\n   ");
  });

  return [
    "SPX Auto-Accept ล้มเหลว",
    `เวลา: ${input.now.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`,
    "",
    ...failLines,
  ].join("\n");
}
