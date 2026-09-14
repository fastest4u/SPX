import type { AutoAcceptJobRow } from "../repositories/auto-accept-job-repository.js";
import { logger } from "../utils/logger.js";
import {
  runAutoAcceptJobDryRunBatch,
  type AutoAcceptDryRunPayloadV1,
  type AutoAcceptDryRunRuleState,
  type AutoAcceptDryRunRuleStateLoader,
  type RunAutoAcceptJobDryRunBatchInput,
} from "./auto-accept-job-dry-run.js";
import type { AutoAcceptWorkerBatchResult } from "./auto-accept-worker.js";
import { readRules } from "./notify-rules.js";

export interface AutoAcceptJobDryRunWorkerOnceOptions {
  nodeId: string;
  teamIds: number[];
  batchSize: number;
  leaseMs: number;
  now?: Date;
  claimTokenFactory?: () => string;
  retryDelayMsOnRuleStateError?: number;
  loadRuleState?: AutoAcceptDryRunRuleStateLoader;
  runBatch?: (input: RunAutoAcceptJobDryRunBatchInput) => Promise<AutoAcceptWorkerBatchResult>;
}

export interface AutoAcceptJobDryRunWorkerLoopOptions extends AutoAcceptJobDryRunWorkerOnceOptions {
  intervalMs: number;
}

export interface AutoAcceptJobDryRunWorkerLoop {
  runOnce(): Promise<AutoAcceptWorkerBatchResult | null>;
  stop(): void;
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

function validateOnceOptions(options: AutoAcceptJobDryRunWorkerOnceOptions): {
  nodeId: string;
  teamIds: number[];
} {
  const nodeId = normalizeNodeId(options.nodeId);
  const teamIds = normalizeTeamIds(options.teamIds);
  requirePositiveInteger("batchSize", options.batchSize);
  requirePositiveInteger("leaseMs", options.leaseMs);
  return { nodeId, teamIds };
}

function validateLoopOptions(options: AutoAcceptJobDryRunWorkerLoopOptions): void {
  validateOnceOptions(options);
  requirePositiveInteger("intervalMs", options.intervalMs);
}

export async function loadAutoAcceptJobDryRunRuleState(input: {
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

export async function runAutoAcceptJobDryRunWorkerOnce(
  options: AutoAcceptJobDryRunWorkerOnceOptions,
): Promise<AutoAcceptWorkerBatchResult> {
  const { nodeId, teamIds } = validateOnceOptions(options);
  const runBatch = options.runBatch ?? runAutoAcceptJobDryRunBatch;

  return await runBatch({
    ownerNodeId: nodeId,
    teamIds,
    limit: options.batchSize,
    leaseMs: options.leaseMs,
    now: options.now,
    claimTokenFactory: options.claimTokenFactory,
    retryDelayMsOnRuleStateError: options.retryDelayMsOnRuleStateError,
    loadRuleState: options.loadRuleState ?? loadAutoAcceptJobDryRunRuleState,
  });
}

export function startAutoAcceptJobDryRunWorkerLoop(
  options: AutoAcceptJobDryRunWorkerLoopOptions,
): AutoAcceptJobDryRunWorkerLoop {
  validateLoopOptions(options);

  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<AutoAcceptWorkerBatchResult | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      return await runAutoAcceptJobDryRunWorkerOnce(options);
    } catch (error) {
      logger.warn("auto-accept-job-dry-run-worker-loop-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      running = false;
    }
  };

  void runOnce();
  const timer = setInterval(() => void runOnce(), options.intervalMs);

  return {
    runOnce,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
