const WATERMARK_FIELDS = Object.freeze([
  "bookingHistory",
  "autoAcceptAttempts",
  "autoAcceptResults",
  "autoAcceptHistory",
  "notificationEvents",
  "notificationOutbox",
  "metrics",
]);

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function evaluateDeliveryCounts(counts, phase) {
  if (
    !counts ||
    !["baseline", "line-down", "recovery"].includes(phase) ||
    !nonNegativeInteger(counts.matchedOutboxRows) ||
    !nonNegativeInteger(counts.success) ||
    !nonNegativeInteger(counts.failed)
  ) {
    return { ok: false, failures: ["DELIVERY_EVIDENCE_INVALID"] };
  }
  const failures = [];
  if (counts.matchedOutboxRows !== 1) failures.push("OUTBOX_IDENTITY_NOT_UNIQUE");
  if ((phase === "baseline" || phase === "recovery") && counts.success !== 1)
    failures.push("PROVIDER_SUCCESS_COUNT_INVALID");
  if (phase === "line-down" && counts.success !== 0)
    failures.push("PROVIDER_SUCCESS_DURING_OUTAGE");
  if (phase === "baseline" && counts.failed !== 0)
    failures.push("PROVIDER_FAILURE_COUNT_INVALID");
  if ((phase === "line-down" || phase === "recovery") && counts.failed < 1)
    failures.push("PROVIDER_FAILURE_COUNT_INVALID");
  return { ok: failures.length === 0, failures };
}

export function evaluateRuntimeOwner(rows, options) {
  if (!Array.isArray(rows) || !options || !Number.isInteger(options.teamId)) {
    return { ok: false, failures: ["RUNTIME_OWNER_EVIDENCE_INVALID"] };
  }
  const teamRows = rows.filter((row) => row?.teamId === options.teamId);
  const prior = teamRows.find((row) => row.nodeId === options.expectedInactiveNodeId);
  if (prior?.active === true) return { ok: false, failures: ["PRIOR_OWNER_STILL_ACTIVE"] };
  const active = teamRows.filter((row) => row?.active === true);
  const selected = active.filter((row) => row.nodeId === options.expectedActiveNodeId);
  const failures = [];
  if (selected.length !== 1 || active.length !== 1) failures.push("ACTIVE_OWNER_MISMATCH");
  if (!prior || prior.active !== false) failures.push("PRIOR_OWNER_EVIDENCE_MISSING");
  if (
    selected.length === 1 &&
    (!nonNegativeInteger(selected[0].heartbeatAgeMs) ||
      selected[0].heartbeatAgeMs > options.maxHeartbeatAgeMs)
  )
    failures.push("ACTIVE_OWNER_HEARTBEAT_STALE");
  return { ok: failures.length === 0, failures };
}

function validWatermark(value) {
  return Boolean(
    value &&
      WATERMARK_FIELDS.every((field) => nonNegativeInteger(value[field])) &&
      nonNegativeInteger(value.duplicateAnomalies),
  );
}

export function compareWatermarks(before, after) {
  if (!validWatermark(before) || !validWatermark(after)) {
    return { ok: false, failures: ["WATERMARK_EVIDENCE_INVALID"] };
  }
  const failures = [];
  if (WATERMARK_FIELDS.some((field) => after[field] < before[field]))
    failures.push("WATERMARK_REGRESSED");
  if (after.duplicateAnomalies > 0) failures.push("DUPLICATE_OPERATION_ANOMALY");
  return { ok: failures.length === 0, failures };
}

export function evaluateWorkerEvidence(value) {
  const failures = [];
  if (!value || value.isolationModel !== "same-host") failures.push("ISOLATION_MODEL_OVERCLAIM");
  if (typeof value?.note === "string" && /multi[- ]?host|\bha\b|host[- ]fault[- ]tolerant/i.test(value.note))
    failures.push("AVAILABILITY_OVERCLAIM");
  if (!value?.baseline?.webReady || typeof value?.baseline?.owner !== "string")
    failures.push("BASELINE_EVIDENCE_INVALID");
  if (
    value?.forward?.priorReleased !== true ||
    value?.forward?.priorInactive !== true ||
    value?.forward?.metricsFailures !== 0 ||
    typeof value?.forward?.owner !== "string" ||
    value?.forward?.owner === value?.baseline?.owner
  )
    failures.push("FORWARD_HANDOFF_INVALID");
  if (
    value?.reverse?.replacementReleased !== true ||
    value?.reverse?.replacementInactive !== true ||
    value?.reverse?.metricsFailures !== 0 ||
    value?.reverse?.owner !== value?.baseline?.owner
  )
    failures.push("REVERSE_HANDOFF_INVALID");
  if (!value?.final?.webReady || value?.final?.duplicateAnomalies !== 0)
    failures.push("FINAL_EVIDENCE_INVALID");
  const forward = compareWatermarks(value?.baseline?.watermark, value?.forward?.watermark);
  const reverse = compareWatermarks(value?.forward?.watermark, value?.reverse?.watermark);
  failures.push(...forward.failures, ...reverse.failures);
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}
