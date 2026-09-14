import type { ServiceHealthSnapshot } from "./service-health.js";

export interface OcrReadModel {
  generatedAt: string;
  scope: { kind: "admin" };
  health: ServiceHealthSnapshot | null;
  totals: {
    completedExtractions: number;
    succeededJobs: number | null;
    failedJobs: number | null;
    timedOutJobs: number | null;
    pendingJobs: number | null;
  };
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
}

function normalizeIsoTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function cloneHealthSnapshot(snapshot: ServiceHealthSnapshot): ServiceHealthSnapshot {
  return {
    ...snapshot,
    details: {},
  };
}

function selectOcrHealth(serviceHealth: ServiceHealthSnapshot[]): ServiceHealthSnapshot | null {
  const snapshot = serviceHealth.find(
    (item) => item.service === "ocr-service" || item.role === "ocr-service",
  );
  return snapshot ? cloneHealthSnapshot(snapshot) : null;
}

export function buildOcrReadModel(input: {
  generatedAt: string;
  completedExtractions: number;
  lastCompletedAt: string | Date | null;
  serviceHealth: ServiceHealthSnapshot[];
}): OcrReadModel {
  return {
    generatedAt: input.generatedAt,
    scope: { kind: "admin" },
    health: selectOcrHealth(input.serviceHealth),
    totals: {
      completedExtractions: input.completedExtractions,
      succeededJobs: null,
      failedJobs: null,
      timedOutJobs: null,
      pendingJobs: null,
    },
    lastCompletedAt: normalizeIsoTimestamp(input.lastCompletedAt),
    lastFailureAt: null,
  };
}
