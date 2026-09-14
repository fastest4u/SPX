export interface ProviderDeliveryReadModelRow {
  provider: string;
  status: string;
  finishedAt: string | Date | null;
  errorMessage: string | null;
}

export interface ProviderDeliveryReadModel {
  generatedAt: string;
  scope: { kind: "admin" } | { kind: "team"; teamId: number };
  window: { from: string; to: string };
  providers: Array<{
    provider: string;
    successCount: number;
    failedCount: number;
    ambiguousCount: number;
    reconciledSuccessCount: number;
    reconciledNotSentCount: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorClass: string | null;
  }>;
}

type ProviderSummary = ProviderDeliveryReadModel["providers"][number] & {
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
};

type NormalizedDeliveryStatus =
  | "success"
  | "failed"
  | "ambiguous"
  | "reconciled_success"
  | "reconciled_not_sent";

function normalizeStatus(status: string): NormalizedDeliveryStatus | null {
  const trimmed = status.trim().toLowerCase();
  if (
    trimmed === "success" ||
    trimmed === "failed" ||
    trimmed === "ambiguous" ||
    trimmed === "reconciled_success" ||
    trimmed === "reconciled_not_sent"
  ) {
    return trimmed;
  }
  return null;
}

function normalizeFinishedAt(finishedAt: string | Date | null): { iso: string; ms: number } | null {
  if (finishedAt === null) return null;
  const date = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  return { iso: date.toISOString(), ms };
}

function classifyErrorClass(errorMessage: string | null): string | null {
  const message = errorMessage?.trim();
  if (!message) return null;
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("rate") || lower.includes("429") || lower.includes("limit")) return "rate_limited";
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403")) return "auth";
  if (lower.includes("target") || lower.includes("rejected") || lower.includes("not found")) return "target_rejected";
  return "provider_error";
}

function ensureProviderSummary(
  summaries: Map<string, ProviderSummary>,
  provider: string,
): ProviderSummary {
  const existing = summaries.get(provider);
  if (existing) return existing;

  const summary: ProviderSummary = {
    provider,
    successCount: 0,
    failedCount: 0,
    ambiguousCount: 0,
    reconciledSuccessCount: 0,
    reconciledNotSentCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorClass: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
  };
  summaries.set(provider, summary);
  return summary;
}

function updateLatestTimestamp(
  currentMs: number | null,
  currentIso: string | null,
  next: { ms: number; iso: string },
): { ms: number; iso: string } {
  if (currentMs === null || next.ms > currentMs) {
    return next;
  }
  return { ms: currentMs, iso: currentIso ?? next.iso };
}

export function buildProviderDeliveryReadModel(input: {
  rows: ProviderDeliveryReadModelRow[];
  generatedAt: string;
  scope: ProviderDeliveryReadModel["scope"];
  window: ProviderDeliveryReadModel["window"];
}): ProviderDeliveryReadModel {
  const summaries = new Map<string, ProviderSummary>();

  for (const row of input.rows) {
    const normalizedStatus = normalizeStatus(row.status);
    if (!normalizedStatus) continue;

    const summary = ensureProviderSummary(summaries, row.provider);
    const finishedAt = normalizeFinishedAt(row.finishedAt);

    if (normalizedStatus === "success" || normalizedStatus === "reconciled_success") {
      summary.successCount += 1;
      if (normalizedStatus === "reconciled_success") summary.reconciledSuccessCount += 1;
      if (finishedAt) {
        const updated = updateLatestTimestamp(summary.lastSuccessAtMs, summary.lastSuccessAt, finishedAt);
        summary.lastSuccessAtMs = updated.ms;
        summary.lastSuccessAt = updated.iso;
      }
      continue;
    }

    if (normalizedStatus === "ambiguous") {
      summary.ambiguousCount += 1;
    } else {
      summary.failedCount += 1;
      if (normalizedStatus === "reconciled_not_sent") summary.reconciledNotSentCount += 1;
    }
    if (finishedAt) {
      const updated = updateLatestTimestamp(summary.lastFailureAtMs, summary.lastFailureAt, finishedAt);
      const isNewestFailure = summary.lastFailureAtMs === null || finishedAt.ms > summary.lastFailureAtMs;
      summary.lastFailureAtMs = updated.ms;
      summary.lastFailureAt = updated.iso;
      if (isNewestFailure) {
        summary.lastErrorClass = classifyErrorClass(row.errorMessage);
      }
    } else if (summary.lastFailureAt === null) {
      summary.lastErrorClass = classifyErrorClass(row.errorMessage);
    }
  }

  const providers = Array.from(summaries.values())
    .map(({ lastSuccessAtMs: _lastSuccessAtMs, lastFailureAtMs: _lastFailureAtMs, ...provider }) => provider)
    .sort((left, right) => left.provider.localeCompare(right.provider));

  return {
    generatedAt: input.generatedAt,
    scope: input.scope,
    window: input.window,
    providers,
  };
}
