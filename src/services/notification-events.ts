export type NotificationEventType =
  | "auto_accept_result"
  | "auto_accept_partial_result"
  | "auto_accept_failure"
  | "session_expired"
  | "team_worker_status"
  | "notifier_health";

export type NotificationSeverity = "success" | "warning" | "error" | "info";
export type AutoAcceptEventStatus = "owned" | "partial" | "lost" | "failed" | "unknown";

const notificationEventTypes: readonly NotificationEventType[] = [
  "auto_accept_result",
  "auto_accept_partial_result",
  "auto_accept_failure",
  "session_expired",
  "team_worker_status",
  "notifier_health",
];

const notificationSeverities: readonly NotificationSeverity[] = ["success", "warning", "error", "info"];
const autoAcceptEventStatuses: readonly AutoAcceptEventStatus[] = ["owned", "partial", "lost", "failed", "unknown"];

export interface NotificationEventInput {
  schemaVersion: 1;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  teamId: number;
  teamName: string;
  bookingId?: string;
  requestIds?: string[];
  status?: AutoAcceptEventStatus;
  reasonCode?: string;
  traceId?: string;
  message: string;
  occurredAt: string;
  evidence?: Record<string, unknown>;
}

export interface NormalizedNotificationEvent {
  eventKey: string;
  schemaVersion: 1;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  teamId: number;
  workerNodeId: string;
  traceId: string | null;
  subjectType: string;
  subjectId: string;
  payload: NotificationEventInput;
}

export function buildAutoAcceptEventKey(input: {
  status: "owned" | "lost" | "failed" | "unknown";
  teamId: number;
  bookingId: string;
  requestId: string;
}): string {
  return `auto_accept_${input.status}:team:${input.teamId}:booking:${input.bookingId}:req:${input.requestId}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function requireOneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function requireRequestIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("requestIds must contain at least one id");
  return value.map((requestId) => requireString(requestId, "requestIds"));
}

export function normalizeNotificationEvent(input: NotificationEventInput, workerNodeId: string, eventKey: string): NormalizedNotificationEvent {
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const eventType = requireOneOf(input.eventType, "eventType", notificationEventTypes);
  const severity = requireOneOf(input.severity, "severity", notificationSeverities);
  const status = input.status === undefined ? undefined : requireOneOf(input.status, "status", autoAcceptEventStatuses);
  if (!Number.isInteger(input.teamId) || input.teamId <= 0) throw new Error("teamId must be a positive integer");
  const teamName = requireString(input.teamName, "teamName");
  const message = requireString(input.message, "message");
  const occurredAt = requireString(input.occurredAt, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("occurredAt must be a valid date");
  const normalizedWorkerNodeId = requireString(workerNodeId, "workerNodeId");
  const normalizedEventKey = requireString(eventKey, "eventKey");

  if (eventType.startsWith("auto_accept")) {
    const bookingId = requireString(input.bookingId, "bookingId");
    const requestIds = requireRequestIds(input.requestIds);
    const payload: NotificationEventInput = {
      ...input,
      schemaVersion: 1,
      eventType,
      severity,
      teamName,
      bookingId,
      requestIds,
      status,
      message,
      occurredAt,
    };

    return {
      eventKey: normalizedEventKey,
      schemaVersion: 1,
      eventType,
      severity,
      teamId: input.teamId,
      workerNodeId: normalizedWorkerNodeId,
      traceId: input.traceId ?? null,
      subjectType: "booking",
      subjectId: bookingId,
      payload,
    };
  }

  const payload: NotificationEventInput = {
    ...input,
    schemaVersion: 1,
    eventType,
    severity,
    teamName,
    status,
    message,
    occurredAt,
  };

  return {
    eventKey: normalizedEventKey,
    schemaVersion: 1,
    eventType,
    severity,
    teamId: input.teamId,
    workerNodeId: normalizedWorkerNodeId,
    traceId: input.traceId ?? null,
    subjectType: eventType,
    subjectId: `${input.teamId}`,
    payload,
  };
}
