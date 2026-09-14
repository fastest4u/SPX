import { logger } from "../utils/logger.js";
import {
  createAutoAcceptJobSettlementOperations,
  runAutoAcceptJobSettlementBatch,
  type AutoAcceptJobSettlementOperations,
  type RunAutoAcceptJobSettlementBatchInput,
} from "./auto-accept-job-settlement.js";
import type { AutoAcceptWorkerBatchResult } from "./auto-accept-worker.js";

export interface AutoAcceptJobSettlementWorkerOnceOptions {
  nodeId: string;
  teamIds: number[];
  batchSize: number;
  leaseMs: number;
  now?: Date;
  claimTokenFactory?: () => string;
  retryDelayMsOnSettlementError?: number;
  operations?: AutoAcceptJobSettlementOperations;
  runBatch?: (input: RunAutoAcceptJobSettlementBatchInput) => Promise<AutoAcceptWorkerBatchResult>;
}

export interface AutoAcceptJobSettlementWorkerLoopOptions
  extends AutoAcceptJobSettlementWorkerOnceOptions {
  intervalMs: number;
}

export interface AutoAcceptJobSettlementWorkerLoop {
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

function validateOnceOptions(options: AutoAcceptJobSettlementWorkerOnceOptions): {
  nodeId: string;
  teamIds: number[];
} {
  const nodeId = normalizeNodeId(options.nodeId);
  const teamIds = normalizeTeamIds(options.teamIds);
  requirePositiveInteger("batchSize", options.batchSize);
  requirePositiveInteger("leaseMs", options.leaseMs);
  return { nodeId, teamIds };
}

function validateLoopOptions(options: AutoAcceptJobSettlementWorkerLoopOptions): void {
  validateOnceOptions(options);
  requirePositiveInteger("intervalMs", options.intervalMs);
}

export async function runAutoAcceptJobSettlementWorkerOnce(
  options: AutoAcceptJobSettlementWorkerOnceOptions,
): Promise<AutoAcceptWorkerBatchResult> {
  const { nodeId, teamIds } = validateOnceOptions(options);
  const runBatch = options.runBatch ?? runAutoAcceptJobSettlementBatch;

  return await runBatch({
    ownerNodeId: nodeId,
    teamIds,
    limit: options.batchSize,
    leaseMs: options.leaseMs,
    now: options.now,
    claimTokenFactory: options.claimTokenFactory,
    retryDelayMsOnSettlementError: options.retryDelayMsOnSettlementError,
    operations: options.operations ?? createAutoAcceptJobSettlementOperations(),
  });
}

export function startAutoAcceptJobSettlementWorkerLoop(
  options: AutoAcceptJobSettlementWorkerLoopOptions,
): AutoAcceptJobSettlementWorkerLoop {
  validateLoopOptions(options);

  let running = false;
  let stopped = false;

  const runOnce = async (): Promise<AutoAcceptWorkerBatchResult | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      return await runAutoAcceptJobSettlementWorkerOnce(options);
    } catch (error) {
      logger.warn("auto-accept-job-settlement-worker-loop-failed", {
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
