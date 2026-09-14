import { randomUUID } from "node:crypto";
import {
  claimAutoAcceptJobs,
  getAutoAcceptJobById,
  markAutoAcceptJobResultCheckpoint,
  markAutoAcceptJobCompleted,
  markAutoAcceptJobDeadLetter,
  markAutoAcceptJobRetrying,
  markAutoAcceptJobSettlementCheckpoint,
  renewAutoAcceptJobClaim,
  type AutoAcceptJobResultStatus,
  type AutoAcceptJobRow,
  type AutoAcceptJobClaimScope,
  type MarkAutoAcceptJobResultCheckpointInput,
  type MarkAutoAcceptJobSettlementCheckpointInput,
} from "../repositories/auto-accept-job-repository.js";

export type AutoAcceptJobExecutionResult =
  | {
      outcome: "succeeded";
      resultStatus: Extract<AutoAcceptJobResultStatus, "owned">;
      reasonCode: string;
      winningAttemptTraceId?: string | null;
      progressSettledAt?: Date | null;
      historyWrittenAt?: Date | null;
      notificationEnqueuedAt?: Date | null;
    }
  | {
      outcome: "failed" | "indeterminate" | "cancelled";
      /** Quarantine releases ownership while retaining prior canonical/settlement evidence. */
      preserveEvidence?: boolean;
      resultStatus?: AutoAcceptJobResultStatus | null;
      reasonCode: string;
      winningAttemptTraceId?: string | null;
    }
  | {
      outcome: "checkpoint";
      checkpoint: "canonical_result";
      resultStatus: AutoAcceptJobResultStatus;
      reasonCode: string;
      winningAttemptTraceId?: string | null;
      progressSettledAt?: Date | null;
      historyWrittenAt?: Date | null;
      notificationEnqueuedAt?: Date | null;
    }
  | {
      outcome: "retry";
      reasonCode: string;
      error?: string | null;
      retryDelayMs: number;
      count: "attempt" | "verify";
    }
  | {
      outcome: "dead_letter";
      reasonCode: string;
      error?: string | null;
    };

export interface AutoAcceptJobExecutionContext {
  row: AutoAcceptJobRow;
  claimToken: string;
  ownerNodeId: string;
  now: Date;
  currentTime: () => Date;
  renewClaim: (leaseMs?: number, now?: Date) => Promise<boolean>;
  checkpointResult: (
    checkpoint: Omit<MarkAutoAcceptJobResultCheckpointInput, "id" | "ownerNodeId" | "claimToken" | "now">,
    now?: Date,
  ) => Promise<boolean>;
  checkpointSettlement: (
    checkpoint: Omit<MarkAutoAcceptJobSettlementCheckpointInput, "id" | "ownerNodeId" | "claimToken" | "now">,
    now?: Date,
  ) => Promise<boolean>;
}

export type AutoAcceptJobExecutor = (
  context: AutoAcceptJobExecutionContext,
) => Promise<AutoAcceptJobExecutionResult> | AutoAcceptJobExecutionResult;

export interface RunAutoAcceptWorkerBatchInput {
  ownerNodeId: string;
  teamIds: number[];
  limit: number;
  leaseMs: number;
  execute: AutoAcceptJobExecutor;
  claimScope?: AutoAcceptJobClaimScope;
  now?: Date;
  clock?: () => Date;
  claimTokenFactory?: () => string;
  retryDelayMsOnError?: number;
}

export interface AutoAcceptWorkerBatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  indeterminate: number;
  cancelled: number;
  retried: number;
  deadLettered: number;
  executorErrors: number;
  settleFailures: number;
  checkpointed: number;
  checkpointFailures: number;
}

const DEFAULT_EXECUTOR_ERROR_RETRY_DELAY_MS = 30_000;

function emptyBatchResult(): AutoAcceptWorkerBatchResult {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeClaimToken(token: string): string {
  return token.substring(0, 80);
}

function normalizeClaimOwner(ownerNodeId: string): string {
  return ownerNodeId.substring(0, 120);
}

function incrementCompletedCounter(result: AutoAcceptWorkerBatchResult, outcome: "succeeded" | "failed" | "indeterminate" | "cancelled"): void {
  if (outcome === "succeeded") result.succeeded++;
  else if (outcome === "failed") result.failed++;
  else if (outcome === "indeterminate") result.indeterminate++;
  else result.cancelled++;
}

async function retryAfterExecutorError(input: {
  row: AutoAcceptJobRow;
  ownerNodeId: string;
  claimToken: string;
  currentTime: () => Date;
  retryDelayMs: number;
  error: unknown;
}): Promise<boolean> {
  return await markAutoAcceptJobRetrying({
    id: input.row.id,
    ownerNodeId: input.ownerNodeId,
    claimToken: input.claimToken,
    reasonCode: "worker_execution_error",
    error: errorMessage(input.error),
    retryDelayMs: input.retryDelayMs,
    count: "attempt",
    now: input.currentTime(),
  });
}

async function countRetrySettlement(input: {
  row: AutoAcceptJobRow;
  result: AutoAcceptWorkerBatchResult;
}): Promise<void> {
  const current = await getAutoAcceptJobById(input.row.id);
  if (current?.status === "dead_letter") input.result.deadLettered++;
  else input.result.retried++;
}

async function settleExecutionResult(input: {
  row: AutoAcceptJobRow;
  ownerNodeId: string;
  claimToken: string;
  execution: AutoAcceptJobExecutionResult;
  currentTime: () => Date;
}): Promise<boolean> {
  const { row, ownerNodeId, claimToken, execution, currentTime } = input;
  if (execution.outcome === "retry") {
    return await markAutoAcceptJobRetrying({
      id: row.id,
      ownerNodeId,
      claimToken,
      reasonCode: execution.reasonCode,
      error: execution.error,
      retryDelayMs: execution.retryDelayMs,
      count: execution.count,
      now: currentTime(),
    });
  }

  if (execution.outcome === "dead_letter") {
    return await markAutoAcceptJobDeadLetter({
      id: row.id,
      ownerNodeId,
      claimToken,
      reasonCode: execution.reasonCode,
      error: execution.error,
      now: currentTime(),
    });
  }

  if (execution.outcome === "checkpoint") {
    const checkpointed = await markAutoAcceptJobResultCheckpoint({
      id: row.id,
      ownerNodeId,
      claimToken,
      resultStatus: execution.resultStatus,
      resultReasonCode: execution.reasonCode,
      winningAttemptTraceId: execution.winningAttemptTraceId,
      now: currentTime(),
    });
    if (!checkpointed) return false;

    if (
      execution.progressSettledAt !== undefined ||
      execution.historyWrittenAt !== undefined ||
      execution.notificationEnqueuedAt !== undefined
    ) {
      return await markAutoAcceptJobSettlementCheckpoint({
        id: row.id,
        ownerNodeId,
        claimToken,
        ...(execution.progressSettledAt ? { progressSettledAt: execution.progressSettledAt } : {}),
        ...(execution.historyWrittenAt ? { historyWrittenAt: execution.historyWrittenAt } : {}),
        ...(execution.notificationEnqueuedAt ? { notificationEnqueuedAt: execution.notificationEnqueuedAt } : {}),
        now: currentTime(),
      });
    }

    return true;
  }

  return await markAutoAcceptJobCompleted({
    id: row.id,
    ownerNodeId,
    claimToken,
    status: execution.outcome,
    resultStatus: execution.resultStatus,
    resultReasonCode: execution.reasonCode,
    preserveEvidence: "preserveEvidence" in execution && execution.preserveEvidence === true,
    winningAttemptTraceId: execution.winningAttemptTraceId,
    progressSettledAt: execution.outcome === "succeeded" ? execution.progressSettledAt : null,
    historyWrittenAt: execution.outcome === "succeeded" ? execution.historyWrittenAt : null,
    notificationEnqueuedAt: execution.outcome === "succeeded" ? execution.notificationEnqueuedAt : null,
    now: currentTime(),
  });
}

export async function runAutoAcceptWorkerBatch(
  input: RunAutoAcceptWorkerBatchInput,
): Promise<AutoAcceptWorkerBatchResult> {
  const result = emptyBatchResult();
  const fixedNow = input.now;
  const currentTime = input.clock ?? (fixedNow ? () => fixedNow : () => new Date());
  const claimTime = input.now ?? currentTime();
  const ownerNodeId = normalizeClaimOwner(input.ownerNodeId);
  const claimToken = normalizeClaimToken(input.claimTokenFactory?.() ?? randomUUID());
  const rows = await claimAutoAcceptJobs({
    ownerNodeId,
    claimToken,
    scope: input.claimScope ?? "execution",
    teamIds: input.teamIds,
    limit: input.limit,
    leaseMs: input.leaseMs,
    now: claimTime,
  });
  result.claimed = rows.length;

  for (const row of rows) {
    const executionStartedAt = currentTime();
    const renewed = await renewAutoAcceptJobClaim({
      id: row.id,
      ownerNodeId,
      claimToken,
      leaseMs: input.leaseMs,
      now: executionStartedAt,
    });
    if (!renewed) {
      result.settleFailures++;
      continue;
    }

    let execution: AutoAcceptJobExecutionResult;
    try {
      execution = await input.execute({
        row,
        claimToken,
        ownerNodeId,
        now: executionStartedAt,
        currentTime,
        renewClaim: async (leaseMs = input.leaseMs, renewNow = currentTime()) => {
          return await renewAutoAcceptJobClaim({
            id: row.id,
            ownerNodeId,
            claimToken,
            leaseMs,
            now: renewNow,
          });
        },
        checkpointResult: async (checkpoint, checkpointNow = currentTime()) => {
          return await markAutoAcceptJobResultCheckpoint({
            id: row.id,
            ownerNodeId,
            claimToken,
            ...checkpoint,
            now: checkpointNow,
          });
        },
        checkpointSettlement: async (checkpoint, checkpointNow = currentTime()) => {
          return await markAutoAcceptJobSettlementCheckpoint({
            id: row.id,
            ownerNodeId,
            claimToken,
            ...checkpoint,
            now: checkpointNow,
          });
        },
      });
    } catch (error) {
      result.executorErrors++;
      const settled = await retryAfterExecutorError({
        row,
        ownerNodeId,
        claimToken,
        currentTime,
        retryDelayMs: input.retryDelayMsOnError ?? DEFAULT_EXECUTOR_ERROR_RETRY_DELAY_MS,
        error,
      });
      if (settled) await countRetrySettlement({ row, result });
      else result.settleFailures++;
      continue;
    }

    const settled = await settleExecutionResult({
      row,
      ownerNodeId,
      claimToken,
      execution,
      currentTime,
    });
    if (!settled) {
      if (execution.outcome === "checkpoint") result.checkpointFailures++;
      else result.settleFailures++;
      continue;
    }

    if (execution.outcome === "retry") await countRetrySettlement({ row, result });
    else if (execution.outcome === "dead_letter") result.deadLettered++;
    else if (execution.outcome === "checkpoint") result.checkpointed++;
    else incrementCompletedCounter(result, execution.outcome);
  }

  return result;
}
