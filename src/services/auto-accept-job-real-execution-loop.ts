import { randomUUID } from "node:crypto";
import { executionMetricsSnapshot } from "./execution-metrics.js";
import type { RealtimePublisher } from "./realtime-contract.js";
import { markExecutionOnlyMetricsTeam, teamMetricsCollector } from "./metrics.js";
import { env } from "../config/env.js";
import type { AutoAcceptJobRow } from "../repositories/auto-accept-job-repository.js";
import { listTeamRuntimeDesiredStates } from "../repositories/runtime-repository.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import { logger } from "../utils/logger.js";
import { ApiClient } from "./api-client.js";
import type {
  AutoAcceptDryRunPayloadV1,
  AutoAcceptDryRunRuleState,
  AutoAcceptDryRunRuleStateLoader,
} from "./auto-accept-job-dry-run.js";
import {
  runAutoAcceptJobRealExecutionBatch,
  type AutoAcceptJobRealExecutionApi,
  type RunAutoAcceptJobRealExecutionBatchInput,
} from "./auto-accept-job-real-execution.js";
import type { AutoAcceptWorkerBatchResult } from "./auto-accept-worker.js";
import { readRules } from "./notify-rules.js";

export type AutoAcceptJobRealApiClientLoader = (
  teamId: number,
) => Promise<AutoAcceptJobRealExecutionApi | null>;

export type AutoAcceptJobRealNewAttemptPolicyLoader = (
  teamId: number,
) => Promise<boolean>;

export interface AutoAcceptJobRealWorkerOnceOptions {
  nodeId: string;
  teamIds: number[];
  batchSize: number;
  leaseMs: number;
  now?: Date;
  claimTokenFactory?: () => string;
  retryDelayMsOnRuleStateError?: number;
  retryDelayMsOnSettlementPending?: number;
  retryDelayMsOnCheckpointError?: number;
  ambiguousRecheckDelayMs?: number;
  loadRuleState?: AutoAcceptDryRunRuleStateLoader;
  apiClientForTeam?: AutoAcceptJobRealApiClientLoader;
  newExternalAttemptPolicyForTeam?: AutoAcceptJobRealNewAttemptPolicyLoader;
  runBatch?: (input: RunAutoAcceptJobRealExecutionBatchInput) => Promise<AutoAcceptWorkerBatchResult>;
}

export interface AutoAcceptJobRealWorkerLoopOptions extends AutoAcceptJobRealWorkerOnceOptions {
  intervalMs: number;
  /** Startup ownership, independent of whether the collector has observed its first poll. */
  metricsPublication?: "dedicated" | "primary-owned" | "disabled";
  realtimePublisher?: RealtimePublisher;
}

export interface AutoAcceptJobRealWorkerLoop {
  runOnce(): Promise<AutoAcceptWorkerBatchResult | null>;
  stop(): void;
}

function emptySummary(): AutoAcceptWorkerBatchResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
  };
}

function addSummary(target: AutoAcceptWorkerBatchResult, source: AutoAcceptWorkerBatchResult): void {
  target.claimed += source.claimed;
  target.succeeded += source.succeeded;
  target.failed += source.failed;
  target.indeterminate += source.indeterminate;
  target.cancelled += source.cancelled;
  target.retried += source.retried;
  target.deadLettered += source.deadLettered;
  target.executorErrors += source.executorErrors;
  target.settleFailures += source.settleFailures;
  target.checkpointed += source.checkpointed;
  target.checkpointFailures += source.checkpointFailures;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function normalizeNodeId(nodeId: string): string {
  const normalized = nodeId.trim();
  if (!normalized) throw new Error("nodeId is required");
  return normalized;
}

function normalizeTeamIds(teamIds: number[]): number[] {
  if (teamIds.length === 0) {
    throw new Error("teamIds must include at least one assigned team id");
  }
  const normalized = [...new Set(teamIds)];
  for (const teamId of normalized) requirePositiveInteger("teamId", teamId);
  return normalized;
}

function validateOnceOptions(options: AutoAcceptJobRealWorkerOnceOptions): {
  nodeId: string;
  teamIds: number[];
} {
  const nodeId = normalizeNodeId(options.nodeId);
  const teamIds = normalizeTeamIds(options.teamIds);
  requirePositiveInteger("batchSize", options.batchSize);
  requirePositiveInteger("leaseMs", options.leaseMs);
  return { nodeId, teamIds };
}

function validateLoopOptions(options: AutoAcceptJobRealWorkerLoopOptions): void {
  validateOnceOptions(options);
  requirePositiveInteger("intervalMs", options.intervalMs);
}

export async function loadAutoAcceptJobRealRuleState(input: {
  row: AutoAcceptJobRow;
  payload: AutoAcceptDryRunPayloadV1;
}): Promise<AutoAcceptDryRunRuleState | null> {
  const rules = await readRules(input.row.teamId);
  const rule = rules.find((candidate) => candidate.id === input.payload.ruleId);
  if (!rule) return null;
  return {
    need: rule.need,
    accept_all: rule.accept_all,
    enabled: rule.enabled,
    fulfilled: rule.fulfilled,
  };
}

export async function loadAutoAcceptJobRealApiClientForTeam(
  teamId: number,
): Promise<AutoAcceptJobRealExecutionApi | null> {
  const team = await getTeamRuntimeConfig(teamId);
  if (!team) {
    logger.debug("auto-accept-job-real-worker-team-skipped", { teamId, reason: "team_not_found" });
    return null;
  }
  if (!team.spxCookie || !team.spxDeviceId) {
    logger.debug("auto-accept-job-real-worker-team-skipped", { teamId, reason: "missing_credentials" });
    return null;
  }

  return new ApiClient({
    metricsCollector: teamMetricsCollector(teamId, team.name),
    credentials: {
      spxCookie: team.spxCookie,
      spxDeviceId: team.spxDeviceId,
    },
    pollIntervalMsProvider: () => env.POLL_INTERVAL_MS,
  });
}

export async function loadAutoAcceptJobRealNewAttemptPolicyForTeam(
  teamId: number,
): Promise<boolean> {
  const [team, desiredStates] = await Promise.all([
    getTeamRuntimeConfig(teamId),
    listTeamRuntimeDesiredStates(),
  ]);
  if (!team?.enabled) return false;

  const desiredState = desiredStates.find((row) => row.teamId === teamId)?.desiredState;
  return desiredState === undefined || desiredState === "running";
}

export async function runAutoAcceptJobRealWorkerOnce(
  options: AutoAcceptJobRealWorkerOnceOptions,
): Promise<AutoAcceptWorkerBatchResult> {
  const { nodeId, teamIds } = validateOnceOptions(options);
  const runBatch = options.runBatch ?? runAutoAcceptJobRealExecutionBatch;
  const apiClientForTeam = options.apiClientForTeam ?? loadAutoAcceptJobRealApiClientForTeam;
  const newExternalAttemptPolicyForTeam = options.newExternalAttemptPolicyForTeam
    ?? loadAutoAcceptJobRealNewAttemptPolicyForTeam;
  const loadRuleState = options.loadRuleState ?? loadAutoAcceptJobRealRuleState;
  const summary = emptySummary();

  for (const teamId of teamIds) {
    const apiClient = await apiClientForTeam(teamId);
    if (!apiClient) continue;

    const teamSummary = await runBatch({
      ownerNodeId: nodeId,
      teamIds: [teamId],
      limit: options.batchSize,
      leaseMs: options.leaseMs,
      now: options.now,
      claimTokenFactory: options.claimTokenFactory,
      retryDelayMsOnRuleStateError: options.retryDelayMsOnRuleStateError,
      retryDelayMsOnSettlementPending: options.retryDelayMsOnSettlementPending,
      retryDelayMsOnCheckpointError: options.retryDelayMsOnCheckpointError,
      ambiguousRecheckDelayMs: options.ambiguousRecheckDelayMs,
      loadRuleState,
      metricsCollector: teamMetricsCollector(teamId),
      apiClient,
      canStartNewExternalAttempt: async (input) => (
        input.teamId === teamId && await newExternalAttemptPolicyForTeam(teamId)
      ),
    });
    addSummary(summary, teamSummary);
  }

  return summary;
}

const executionMetricsGeneration = randomUUID();
const executionMetricsStartedAt = new Date().toISOString();
const EXECUTION_METRICS_INTERVAL_MS = 5000;

export function startAutoAcceptJobRealWorkerLoop(
  options: AutoAcceptJobRealWorkerLoopOptions,
): AutoAcceptJobRealWorkerLoop {
  validateLoopOptions(options);

  let running = false;
  let stopped = false;
  let publishing = false;
  const teamIds = normalizeTeamIds(options.teamIds);
  if (options.metricsPublication === "dedicated") {
    for (const teamId of teamIds) markExecutionOnlyMetricsTeam(teamId);
  }
  // Separate timer and in-flight fence: telemetry is never awaited by dispatch,
  // and a hung publisher suppresses later telemetry rather than accumulating work.
  const publishMetrics = async (): Promise<void> => {
    if (stopped || publishing || !options.realtimePublisher) return;
    publishing = true;
    try {
      for (const teamId of teamIds) {
        if (stopped) break;
        await options.realtimePublisher.publishSnapshot({
          type: "metrics.execution.snapshot", payloadVersion: 1, replayable: false,
          source: { service: "auto-accept-service", role: "auto-accept-service", nodeId: options.nodeId },
          scope: { kind: "team", teamId }, emittedAt: new Date().toISOString(),
          payload: executionMetricsSnapshot(teamMetricsCollector(teamId).snapshot(), executionMetricsGeneration, executionMetricsStartedAt),
        });
      }
    } catch (error) {
      logger.warn("auto-accept-execution-metrics-publish-failed", { error: error instanceof Error ? error.message : String(error) });
    } finally { publishing = false; }
  };

  const runOnce = async (): Promise<AutoAcceptWorkerBatchResult | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      return await runAutoAcceptJobRealWorkerOnce(options);
    } catch (error) {
      logger.warn("auto-accept-job-real-worker-loop-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      running = false;
    }
  };

  void runOnce();
  const timer = setInterval(() => void runOnce(), options.intervalMs);
  const metricsTimer = options.metricsPublication === "dedicated" && options.realtimePublisher
    ? setInterval(() => void publishMetrics(), EXECUTION_METRICS_INTERVAL_MS) : null;

  return {
    runOnce,
    stop(): void {
      stopped = true;
      clearInterval(timer);
      if (metricsTimer !== null) clearInterval(metricsTimer);
    },
  };
}
