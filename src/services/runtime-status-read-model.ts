import {
  AUTO_ACCEPT_JOB_DEAD_LETTER_REASON_CODES,
  type AutoAcceptJobQueueSummary,
} from "../repositories/auto-accept-job-repository.js";
import type { LineImageExtractionSummary } from "../repositories/line-image-extraction-repository.js";
import type {
  NotificationQueueSummary,
  ProviderDeliveryReadModelRowsInput,
} from "../repositories/notification-repository.js";
import type {
  listRuntimeNodes,
  listTeamRuntimeLeases,
} from "../repositories/runtime-repository.js";
import { buildOcrReadModel } from "./ocr-read-model.js";
import { buildProviderDeliveryReadModel, type ProviderDeliveryReadModelRow } from "./provider-delivery-read-model.js";
import type { RealtimeScope } from "./realtime-contract.js";
import { RUNTIME_NODE_LOOP_MODES, type RuntimeNodeLoopMode } from "./runtime-node-heartbeat.js";
import { redactServiceHealthDetails, type ServiceHealthSnapshot } from "./service-health.js";
import { z } from "zod";

export type RuntimeNodeRow = Awaited<ReturnType<typeof listRuntimeNodes>>[number];
export type TeamRuntimeLeaseRow = Awaited<ReturnType<typeof listTeamRuntimeLeases>>[number];

export interface RuntimeStatusRecords {
  nodes: RuntimeNodeRow[];
  leases: TeamRuntimeLeaseRow[];
  notifications: NotificationQueueSummary;
  serviceHealth: ServiceHealthSnapshot[];
  providerDeliveryRows: ProviderDeliveryReadModelRow[];
  ocrSummary: LineImageExtractionSummary;
  autoAcceptJobSummary: AutoAcceptJobQueueSummary;
}

export interface RuntimeStatusReadModelDependencies {
  listNodes: () => Promise<RuntimeNodeRow[]>;
  listLeases: () => Promise<TeamRuntimeLeaseRow[]>;
  getNotifications: () => Promise<NotificationQueueSummary>;
  collectServiceHealth: (generatedAt: string) => Promise<ServiceHealthSnapshot[]>;
  getProviderDeliveryRows: (input: ProviderDeliveryReadModelRowsInput) => Promise<ProviderDeliveryReadModelRow[]>;
  getOcrSummary: () => Promise<LineImageExtractionSummary>;
  getAutoAcceptJobSummary: (now: Date) => Promise<AutoAcceptJobQueueSummary>;
}

export interface LoadRuntimeStatusReadModelInput {
  scope: RealtimeScope;
  dependencies: RuntimeStatusReadModelDependencies;
  now?: Date;
}

const NOTIFICATION_QUEUE_STATUSES = [
  "queued",
  "sending",
  "provider_sending",
  "delivery_ambiguous",
  "failed",
  "failed_terminal",
  "sent",
] as const;
const RUNTIME_NODE_STALE_AFTER_MS = 120_000;
const publicNonNegativeNumber = z.number().finite().nonnegative();
const publicTimestamp = z.union([z.string(), z.date()]).transform((value, context) => {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    context.addIssue({ code: "custom", message: "must be a valid timestamp" });
    return z.NEVER;
  }
  if (dateValueToIso(value) === null) {
    context.addIssue({ code: "custom", message: "must be a valid timestamp" });
    return z.NEVER;
  }
  return value;
});
const publicNullableTimestamp = publicTimestamp.nullable();
const publicScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admin") }),
  z.object({ kind: z.literal("team"), teamId: z.number().int().positive() }),
]);
const publicNotificationCounts = z.object({
  queued: publicNonNegativeNumber.optional(),
  sending: publicNonNegativeNumber.optional(),
  provider_sending: publicNonNegativeNumber.optional(),
  delivery_ambiguous: publicNonNegativeNumber.optional(),
  failed: publicNonNegativeNumber.optional(),
  failed_terminal: publicNonNegativeNumber.optional(),
  sent: publicNonNegativeNumber.optional(),
});
const publicServiceHealth = z.object({
  service: z.string(),
  role: z.string(),
  nodeId: z.string(),
  state: z.enum(["ok", "degraded", "down"]),
  checkedAt: publicTimestamp,
  details: z.record(z.string(), z.unknown()).transform((details) => {
    const redacted = redactServiceHealthDetails(details);
    return redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? redacted as Record<string, unknown>
      : {};
  }),
});
const publicRuntimeNodeHeartbeat = z.object({
  state: z.enum(["fresh", "degraded"]),
  ageMs: publicNonNegativeNumber.nullable(),
  staleAfterMs: publicNonNegativeNumber,
});
const publicRuntimeNodeSchema = z.object({
  nodeId: z.string(),
  role: z.string(),
  hostname: z.string().nullable(),
  pid: z.number().int().nullable(),
  version: z.string().nullable(),
  lastHeartbeatAt: publicNullableTimestamp,
  createdAt: publicTimestamp,
  updatedAt: publicTimestamp,
  assignedTeamIds: z.array(z.number().int().positive()).default([]),
  enabledLoopModes: z.array(z.enum(RUNTIME_NODE_LOOP_MODES)).default([]),
  heartbeat: publicRuntimeNodeHeartbeat.nullable().default(null),
});
const publicRuntimeLeaseSchema = z.object({
  teamId: z.number().int().positive(),
  ownerNodeId: z.string(),
  ownerRole: z.string(),
  leaseExpiresAt: publicTimestamp,
  heartbeatAt: publicTimestamp,
  status: z.string(),
  startedAt: publicTimestamp,
  updatedAt: publicTimestamp,
});
const publicWorkerLeaseNode = z.object({
  nodeId: z.string(),
  role: z.string(),
  hostname: z.string().nullable(),
  version: z.string().nullable(),
  lastHeartbeatAt: publicNullableTimestamp,
  stale: z.boolean(),
});
const publicNotificationQueueReadModel = z.object({
  generatedAt: publicTimestamp,
  scope: z.object({ kind: z.literal("admin") }),
  byStatus: z.object({
    queued: publicNonNegativeNumber,
    sending: publicNonNegativeNumber,
    provider_sending: publicNonNegativeNumber,
    delivery_ambiguous: publicNonNegativeNumber,
    failed: publicNonNegativeNumber,
    failed_terminal: publicNonNegativeNumber,
    sent: publicNonNegativeNumber,
  }),
  deadletterCount: publicNonNegativeNumber,
  retryableFailureCount: publicNonNegativeNumber,
  reconciliationRequiredCount: publicNonNegativeNumber,
  lockedCount: publicNonNegativeNumber,
  expiredLockCount: publicNonNegativeNumber,
  oldestQueuedAt: publicNullableTimestamp,
  newestTerminalFailureAt: publicNullableTimestamp,
});
const publicAutoAcceptJobsReadModel = z.object({
  generatedAt: publicTimestamp,
  scope: z.object({ kind: z.literal("admin") }),
  total: publicNonNegativeNumber,
  byStatus: z.object({
    pending: publicNonNegativeNumber,
    claimed: publicNonNegativeNumber,
    retrying: publicNonNegativeNumber,
    verifying: publicNonNegativeNumber,
    succeeded: publicNonNegativeNumber,
    failed: publicNonNegativeNumber,
    indeterminate: publicNonNegativeNumber,
    dead_letter: publicNonNegativeNumber,
    cancelled: publicNonNegativeNumber,
  }),
  byAttemptKind: z.object({
    pending_request: publicNonNegativeNumber,
    non_pending_probe: publicNonNegativeNumber,
    fast_accept_all: publicNonNegativeNumber,
    own_status_reconcile: publicNonNegativeNumber,
  }),
  claimableCount: publicNonNegativeNumber,
  expiredClaimCount: publicNonNegativeNumber,
  inFlightCount: publicNonNegativeNumber,
  terminalCount: publicNonNegativeNumber,
  settlementPendingCount: publicNonNegativeNumber,
  budgetReservations: z.object({
    activeCount: publicNonNegativeNumber,
    staleCount: publicNonNegativeNumber,
    oldestHeldAt: publicNullableTimestamp,
    oldestHeldAgeMs: publicNonNegativeNumber.nullable(),
    staleTtlMs: publicNonNegativeNumber,
  }),
  deadLetters: z.object({
    total: publicNonNegativeNumber,
    byReasonCode: z.object({
      invalid_payload: publicNonNegativeNumber,
      identity_mismatch: publicNonNegativeNumber,
      configuration_error: publicNonNegativeNumber,
      execution_failure: publicNonNegativeNumber,
      verification_indeterminate: publicNonNegativeNumber,
      progress_persistence_failure: publicNonNegativeNumber,
      result_persistence_failure: publicNonNegativeNumber,
      history_persistence_failure: publicNonNegativeNumber,
      notification_persistence_failure: publicNonNegativeNumber,
      unsupported_job: publicNonNegativeNumber,
      other: publicNonNegativeNumber,
    }),
    groups: z.array(z.object({
      teamId: z.number().int().positive(),
      attemptKind: z.enum([
        "pending_request",
        "non_pending_probe",
        "fast_accept_all",
        "own_status_reconcile",
        "other",
      ]),
      reasonCode: z.enum(AUTO_ACCEPT_JOB_DEAD_LETTER_REASON_CODES),
      count: publicNonNegativeNumber,
    })),
  }).nullish().transform((value) => value ?? null),
});
const publicWorkerLeasesReadModel = z.object({
  generatedAt: publicTimestamp,
  teams: z.array(z.object({
    teamId: z.number().int().positive(),
    desiredState: z.string().nullable(),
    lease: z.object({
      ownerNodeId: z.string(),
      ownerRole: z.string(),
      active: z.boolean(),
      state: z.enum(["active", "expired"]),
      status: z.string(),
      heartbeatAt: publicNullableTimestamp,
      leaseExpiresAt: publicNullableTimestamp,
      error: z.object({ present: z.boolean(), class: z.string().nullable() }),
    }),
    node: publicWorkerLeaseNode.nullable(),
  })),
});
const publicDeployVersionReadModel = z.object({
  generatedAt: publicTimestamp,
  services: z.array(z.object({
    service: z.string(),
    nodeId: z.string(),
    role: z.string(),
    version: z.string().nullable(),
    gitSha: z.string().nullable(),
    buildId: z.string().nullable(),
    environment: z.enum(["staging", "production"]).nullable(),
    topology: z.enum(["legacy", "split"]).nullable(),
    imageId: z.string().nullable(),
    imageTag: z.string().nullable(),
    targetDescriptorSha256: z.string().nullable(),
    operatorBundleSha256: z.string().nullable(),
    startedAt: publicNullableTimestamp,
    lastHeartbeatAt: publicNullableTimestamp,
    state: z.enum(["ok", "degraded", "down", "unknown"]),
  })),
  consistency: z.object({
    consistent: z.boolean(),
    failureCodes: z.array(z.enum([
      "RELEASE_IDENTITY_MISSING",
      "MIXED_VERSION",
      "MIXED_GIT_SHA",
      "MIXED_BUILD_ID",
      "MIXED_ENVIRONMENT",
      "MIXED_TOPOLOGY",
      "MIXED_IMAGE_ID",
      "MIXED_IMAGE_TAG",
      "MIXED_TARGET_DESCRIPTOR",
      "MIXED_OPERATOR_BUNDLE",
    ])),
  }),
});
const publicProviderDeliveryReadModel = z.object({
  generatedAt: publicTimestamp,
  scope: publicScope,
  window: z.object({ from: publicTimestamp, to: publicTimestamp }),
  providers: z.array(z.object({
    provider: z.string(),
    successCount: publicNonNegativeNumber,
    failedCount: publicNonNegativeNumber,
    ambiguousCount: publicNonNegativeNumber,
    reconciledSuccessCount: publicNonNegativeNumber,
    reconciledNotSentCount: publicNonNegativeNumber,
    lastSuccessAt: publicNullableTimestamp,
    lastFailureAt: publicNullableTimestamp,
    lastErrorClass: z.string().nullable(),
  })),
});
const publicOcrReadModel = z.object({
  generatedAt: publicTimestamp,
  scope: z.object({ kind: z.literal("admin") }),
  health: publicServiceHealth.nullable(),
  totals: z.object({
    completedExtractions: publicNonNegativeNumber,
    succeededJobs: publicNonNegativeNumber.nullable(),
    failedJobs: publicNonNegativeNumber.nullable(),
    timedOutJobs: publicNonNegativeNumber.nullable(),
    pendingJobs: publicNonNegativeNumber.nullable(),
  }),
  lastCompletedAt: publicNullableTimestamp,
  lastFailureAt: publicNullableTimestamp,
});
const publicRuntimeStatusReadModel = z.object({
  nodes: z.array(publicRuntimeNodeSchema),
  leases: z.array(publicRuntimeLeaseSchema),
  notifications: publicNotificationCounts,
  serviceHealth: z.array(publicServiceHealth),
  readModels: z.object({
    notificationQueue: publicNotificationQueueReadModel,
    autoAcceptJobs: publicAutoAcceptJobsReadModel,
    workerLeases: publicWorkerLeasesReadModel,
    deployVersion: publicDeployVersionReadModel,
    providerDelivery: publicProviderDeliveryReadModel,
    ocr: publicOcrReadModel,
  }),
});

export type PublicRuntimeStatusReadModel = z.infer<typeof publicRuntimeStatusReadModel>;

export function projectPublicRuntimeStatusReadModel(value: unknown): PublicRuntimeStatusReadModel {
  return publicRuntimeStatusReadModel.parse(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function dateValueToIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}.000Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function countFor(summary: NotificationQueueSummary, status: string): number {
  const value = summary[status];
  return Number.isFinite(value) ? value : 0;
}

function classifyRuntimeLeaseError(value: string | null | undefined): { present: boolean; class: string | null } {
  if (!value || value.trim().length === 0) return { present: false, class: null };
  const normalized = value.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("deadline")) {
    return { present: true, class: "timeout" };
  }
  if (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("econn") ||
    normalized.includes("enotfound")
  ) {
    return { present: true, class: "network_error" };
  }
  if (normalized.includes("auth") || normalized.includes("unauthorized") || normalized.includes("forbidden")) {
    return { present: true, class: "auth_error" };
  }
  if (normalized.includes("schema") || normalized.includes("parse") || normalized.includes("validation")) {
    return { present: true, class: "data_error" };
  }
  return { present: true, class: "unknown" };
}

function buildNotificationQueueReadModel(summary: NotificationQueueSummary, generatedAt: string) {
  const byStatus = Object.fromEntries(
    NOTIFICATION_QUEUE_STATUSES.map((status) => [status, countFor(summary, status)]),
  );

  return {
    generatedAt,
    scope: { kind: "admin" as const },
    byStatus,
    deadletterCount: countFor(summary, "failed_terminal"),
    retryableFailureCount: countFor(summary, "failed"),
    reconciliationRequiredCount:
      countFor(summary, "provider_sending") + countFor(summary, "delivery_ambiguous"),
    lockedCount: countFor(summary, "sending"),
    expiredLockCount: 0,
    oldestQueuedAt: null,
    newestTerminalFailureAt: null,
  };
}

function buildAutoAcceptJobsReadModel(summary: AutoAcceptJobQueueSummary, generatedAt: string) {
  return {
    generatedAt,
    scope: { kind: "admin" as const },
    total: summary.total,
    byStatus: summary.byStatus,
    byAttemptKind: summary.byAttemptKind,
    claimableCount: summary.claimableCount,
    expiredClaimCount: summary.expiredClaimCount,
    inFlightCount: summary.inFlightCount,
    terminalCount: summary.terminalCount,
    settlementPendingCount: summary.settlementPendingCount,
    budgetReservations: summary.budgetReservations,
    deadLetters: {
      total: summary.deadLetters.total,
      byReasonCode: {
        invalid_payload: summary.deadLetters.byReasonCode.invalid_payload,
        identity_mismatch: summary.deadLetters.byReasonCode.identity_mismatch,
        configuration_error: summary.deadLetters.byReasonCode.configuration_error,
        execution_failure: summary.deadLetters.byReasonCode.execution_failure,
        verification_indeterminate: summary.deadLetters.byReasonCode.verification_indeterminate,
        progress_persistence_failure: summary.deadLetters.byReasonCode.progress_persistence_failure,
        result_persistence_failure: summary.deadLetters.byReasonCode.result_persistence_failure,
        history_persistence_failure: summary.deadLetters.byReasonCode.history_persistence_failure,
        notification_persistence_failure: summary.deadLetters.byReasonCode.notification_persistence_failure,
        unsupported_job: summary.deadLetters.byReasonCode.unsupported_job,
        other: summary.deadLetters.byReasonCode.other,
      },
      groups: summary.deadLetters.groups.map((group) => ({
        teamId: group.teamId,
        attemptKind: group.attemptKind,
        reasonCode: group.reasonCode,
        count: group.count,
      })),
    },
  };
}

function buildWorkerLeasesReadModel(
  leases: TeamRuntimeLeaseRow[],
  nodes: RuntimeNodeRow[],
  generatedAt: string,
) {
  const generatedAtMs = Date.parse(generatedAt);
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));

  return {
    generatedAt,
    teams: leases.map((lease) => {
      const heartbeatAt = dateValueToIso(lease.heartbeatAt);
      const leaseExpiresAt = dateValueToIso(lease.leaseExpiresAt);
      const active = leaseExpiresAt !== null && Date.parse(leaseExpiresAt) > generatedAtMs;
      const node = nodesById.get(lease.ownerNodeId);
      const nodeHeartbeatAt = dateValueToIso(node?.lastHeartbeatAt);
      const nodeHeartbeatAgeMs = nodeHeartbeatAt === null
        ? Number.POSITIVE_INFINITY
        : generatedAtMs - Date.parse(nodeHeartbeatAt);

      return {
        teamId: lease.teamId,
        desiredState: null,
        lease: {
          ownerNodeId: lease.ownerNodeId,
          ownerRole: lease.ownerRole,
          active,
          state: active ? "active" : "expired",
          status: lease.status,
          heartbeatAt,
          leaseExpiresAt,
          error: classifyRuntimeLeaseError(lease.lastError),
        },
        node: node
          ? {
              nodeId: node.nodeId,
              role: node.role,
              hostname: node.hostname ?? null,
              version: nonEmptyString(node.version),
              lastHeartbeatAt: nodeHeartbeatAt,
              stale: nodeHeartbeatAgeMs > RUNTIME_NODE_STALE_AFTER_MS,
            }
          : null,
      };
    }),
  };
}

function parseMetadataJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isDedicatedRuntimeRole(role: string): boolean {
  return role === "poller-service" || role === "auto-accept-service";
}

function safeAssignedTeamIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const teamIds = value.filter((teamId): teamId is number => (
    typeof teamId === "number" && Number.isInteger(teamId) && teamId > 0
  ));
  return [...new Set(teamIds)].sort((left, right) => left - right);
}

function safeEnabledLoopModes(value: unknown, role: string): RuntimeNodeLoopMode[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((mode): mode is RuntimeNodeLoopMode => (
    typeof mode === "string" && RUNTIME_NODE_LOOP_MODES.includes(mode as RuntimeNodeLoopMode)
  )));
  return RUNTIME_NODE_LOOP_MODES.filter((mode) => (
    selected.has(mode) && (role === "poller-service" ? mode === "poller" : mode !== "poller")
  ));
}

function dedicatedRuntimeNodeStatus(node: RuntimeNodeRow, generatedAt: string) {
  if (!isDedicatedRuntimeRole(node.role)) {
    return {
      assignedTeamIds: [] as number[],
      enabledLoopModes: [] as RuntimeNodeLoopMode[],
      heartbeat: null,
    };
  }

  const metadata = parseMetadataJson(node.metadataJson);
  const lastHeartbeatAt = dateValueToIso(node.lastHeartbeatAt);
  const generatedAtMs = Date.parse(generatedAt);
  const heartbeatAtMs = lastHeartbeatAt === null ? Number.NaN : Date.parse(lastHeartbeatAt);
  const ageMs = Number.isFinite(generatedAtMs) && Number.isFinite(heartbeatAtMs)
    ? Math.max(0, generatedAtMs - heartbeatAtMs)
    : null;

  return {
    assignedTeamIds: safeAssignedTeamIds(metadata?.assignedTeamIds),
    enabledLoopModes: safeEnabledLoopModes(metadata?.enabledLoopModes, node.role),
    heartbeat: {
      state: ageMs !== null && ageMs <= RUNTIME_NODE_STALE_AFTER_MS
        ? "fresh" as const
        : "degraded" as const,
      ageMs,
      staleAfterMs: RUNTIME_NODE_STALE_AFTER_MS,
    },
  };
}

function serviceNameForRole(role: string): string {
  if (role === "api" || role === "combined") return "web-api";
  return role;
}

function publicRuntimeNode(node: RuntimeNodeRow, generatedAt: string) {
  const dedicatedStatus = dedicatedRuntimeNodeStatus(node, generatedAt);
  const publicLastHeartbeatAt = dateValueToIso(node.lastHeartbeatAt) === null
    ? null
    : node.lastHeartbeatAt;
  return {
    nodeId: node.nodeId,
    role: node.role,
    hostname: node.hostname,
    pid: node.pid,
    version: node.version,
    lastHeartbeatAt: publicLastHeartbeatAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ...dedicatedStatus,
  };
}

function publicRuntimeLease(lease: TeamRuntimeLeaseRow) {
  return {
    teamId: lease.teamId,
    ownerNodeId: lease.ownerNodeId,
    ownerRole: lease.ownerRole,
    leaseExpiresAt: lease.leaseExpiresAt,
    heartbeatAt: lease.heartbeatAt,
    status: lease.status,
    startedAt: lease.startedAt,
    updatedAt: lease.updatedAt,
  };
}

function deployStateFor(
  service: string,
  nodeId: string,
  serviceHealth: ServiceHealthSnapshot[],
  hasVersionMetadata: boolean,
  heartbeatDegraded: boolean,
): "ok" | "degraded" | "down" | "unknown" {
  const matchingHealth = serviceHealth.find((snapshot) => (
    snapshot.nodeId === nodeId ||
    snapshot.service === service ||
    snapshot.role === service
  ));
  if (matchingHealth?.state === "down") return "down";
  if (heartbeatDegraded) return "degraded";
  if (matchingHealth) return matchingHealth.state;
  return hasVersionMetadata ? "ok" : "unknown";
}

function buildDeployVersionReadModel(
  nodes: RuntimeNodeRow[],
  serviceHealth: ServiceHealthSnapshot[],
  generatedAt: string,
) {
  const services = nodes.map((node) => {
    const metadata = parseMetadataJson(node.metadataJson);
    const version = nonEmptyString(node.version);
    const gitSha = nonEmptyString(metadata?.gitSha);
    const buildId = nonEmptyString(metadata?.buildId);
    const environment = metadata?.environment === "staging" || metadata?.environment === "production"
      ? metadata.environment
      : null;
    const topology = metadata?.topology === "legacy" || metadata?.topology === "split"
      ? metadata.topology
      : null;
    const imageId = nonEmptyString(metadata?.imageId);
    const imageTag = nonEmptyString(metadata?.imageTag);
    const targetDescriptorSha256 = nonEmptyString(metadata?.targetDescriptorSha256);
    const operatorBundleSha256 = nonEmptyString(metadata?.operatorBundleSha256);
    const startedAt = dateValueToIso(metadata?.startedAt);
    const service = serviceNameForRole(node.role);
    const hasVersionMetadata = version !== null || gitSha !== null || buildId !== null || startedAt !== null;
    const heartbeatDegraded = isDedicatedRuntimeRole(node.role)
      && dedicatedRuntimeNodeStatus(node, generatedAt).heartbeat?.state === "degraded";

    return {
      service,
      nodeId: node.nodeId,
      role: node.role,
      version,
      gitSha,
      buildId,
      environment,
      topology,
      imageId,
      imageTag,
      targetDescriptorSha256,
      operatorBundleSha256,
      startedAt,
      lastHeartbeatAt: dateValueToIso(node.lastHeartbeatAt),
      state: deployStateFor(
        service,
        node.nodeId,
        serviceHealth,
        hasVersionMetadata,
        heartbeatDegraded,
      ),
    };
  });

  const failureCodes: Array<
    "RELEASE_IDENTITY_MISSING"
    | "MIXED_VERSION"
    | "MIXED_GIT_SHA"
    | "MIXED_BUILD_ID"
    | "MIXED_ENVIRONMENT"
    | "MIXED_TOPOLOGY"
    | "MIXED_IMAGE_ID"
    | "MIXED_IMAGE_TAG"
    | "MIXED_TARGET_DESCRIPTOR"
    | "MIXED_OPERATOR_BUNDLE"
  > = [];
  const identityKeys = [
    "version",
    "gitSha",
    "buildId",
    "environment",
    "topology",
    "imageId",
    "imageTag",
    "targetDescriptorSha256",
    "operatorBundleSha256",
  ] as const;
  if (services.some((service) => identityKeys.some((key) => service[key] === null))) {
    failureCodes.push("RELEASE_IDENTITY_MISSING");
  }
  const mixedChecks = [
    ["version", "MIXED_VERSION"],
    ["gitSha", "MIXED_GIT_SHA"],
    ["buildId", "MIXED_BUILD_ID"],
    ["environment", "MIXED_ENVIRONMENT"],
    ["topology", "MIXED_TOPOLOGY"],
    ["imageId", "MIXED_IMAGE_ID"],
    ["imageTag", "MIXED_IMAGE_TAG"],
    ["targetDescriptorSha256", "MIXED_TARGET_DESCRIPTOR"],
    ["operatorBundleSha256", "MIXED_OPERATOR_BUNDLE"],
  ] as const;
  for (const [key, code] of mixedChecks) {
    const values = new Set(services.map((service) => service[key]).filter((value) => value !== null));
    if (values.size > 1) failureCodes.push(code);
  }

  return {
    generatedAt,
    services,
    consistency: { consistent: failureCodes.length === 0, failureCodes },
  };
}

export function buildRuntimeStatusReadModel(input: {
  scope: RealtimeScope;
  generatedAt: string;
  records: RuntimeStatusRecords;
}) {
  const teamId = input.scope.kind === "team" ? input.scope.teamId : null;
  const leases = teamId === null
    ? input.records.leases
    : input.records.leases.filter((lease) => lease.teamId === teamId);
  const ownerNodeIds = new Set(leases.map((lease) => lease.ownerNodeId));
  const nodes = teamId === null
    ? input.records.nodes
    : input.records.nodes.filter((node) => ownerNodeIds.has(node.nodeId));
  const isAdmin = input.scope.kind === "admin";
  const deliveryWindow = {
    from: new Date(Date.parse(input.generatedAt) - 24 * 60 * 60 * 1000).toISOString(),
    to: input.generatedAt,
  };

  return {
    nodes: nodes.map((node) => publicRuntimeNode(node, input.generatedAt)),
    leases: leases.map(publicRuntimeLease),
    notifications: isAdmin ? input.records.notifications : {},
    serviceHealth: isAdmin ? input.records.serviceHealth : [],
    readModels: {
      notificationQueue: isAdmin
        ? buildNotificationQueueReadModel(input.records.notifications, input.generatedAt)
        : null,
      autoAcceptJobs: isAdmin
        ? buildAutoAcceptJobsReadModel(input.records.autoAcceptJobSummary, input.generatedAt)
        : null,
      workerLeases: buildWorkerLeasesReadModel(leases, nodes, input.generatedAt),
      deployVersion: buildDeployVersionReadModel(nodes, isAdmin ? input.records.serviceHealth : [], input.generatedAt),
      providerDelivery: buildProviderDeliveryReadModel({
        rows: input.records.providerDeliveryRows,
        generatedAt: input.generatedAt,
        scope: input.scope,
        window: deliveryWindow,
      }),
      ocr: isAdmin
        ? buildOcrReadModel({
            generatedAt: input.generatedAt,
            completedExtractions: input.records.ocrSummary.completedExtractions,
            lastCompletedAt: input.records.ocrSummary.lastCompletedAt,
            serviceHealth: input.records.serviceHealth,
          })
        : null,
    },
  };
}

const emptyAutoAcceptSummary: AutoAcceptJobQueueSummary = {
  total: 0,
  byStatus: {
    pending: 0,
    claimed: 0,
    retrying: 0,
    verifying: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    dead_letter: 0,
    cancelled: 0,
  },
  byAttemptKind: {
    pending_request: 0,
    non_pending_probe: 0,
    fast_accept_all: 0,
    own_status_reconcile: 0,
  },
  claimableCount: 0,
  expiredClaimCount: 0,
  inFlightCount: 0,
  terminalCount: 0,
  settlementPendingCount: 0,
  budgetReservations: {
    activeCount: 0,
    staleCount: 0,
    oldestHeldAt: null,
    oldestHeldAgeMs: null,
    staleTtlMs: 0,
  },
  deadLetters: {
    total: 0,
    byReasonCode: {
      invalid_payload: 0,
      identity_mismatch: 0,
      configuration_error: 0,
      execution_failure: 0,
      verification_indeterminate: 0,
      progress_persistence_failure: 0,
      result_persistence_failure: 0,
      history_persistence_failure: 0,
      notification_persistence_failure: 0,
      unsupported_job: 0,
      other: 0,
    },
    groups: [],
  },
};

export async function loadRuntimeStatusReadModel(input: LoadRuntimeStatusReadModelInput) {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const deliveryInput: ProviderDeliveryReadModelRowsInput = {
    from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    to: now,
    ...(input.scope.kind === "team" ? { teamId: input.scope.teamId } : {}),
  };
  const isAdmin = input.scope.kind === "admin";

  const [nodes, leases, providerDeliveryRows, notifications, serviceHealth, ocrSummary, autoAcceptJobSummary] = await Promise.all([
    input.dependencies.listNodes(),
    input.dependencies.listLeases(),
    input.dependencies.getProviderDeliveryRows(deliveryInput),
    isAdmin ? input.dependencies.getNotifications() : Promise.resolve({}),
    isAdmin ? input.dependencies.collectServiceHealth(generatedAt) : Promise.resolve([]),
    isAdmin
      ? input.dependencies.getOcrSummary()
      : Promise.resolve({ completedExtractions: 0, lastCompletedAt: null }),
    isAdmin ? input.dependencies.getAutoAcceptJobSummary(now) : Promise.resolve(emptyAutoAcceptSummary),
  ]);

  return buildRuntimeStatusReadModel({
    scope: input.scope,
    generatedAt,
    records: {
      nodes,
      leases,
      notifications,
      serviceHealth,
      providerDeliveryRows,
      ocrSummary,
      autoAcceptJobSummary,
    },
  });
}
