import { logger } from "../utils/logger.js";
import {
  claimNotificationOutboxBatch,
  markNotificationDelivered,
  markNotificationFailed,
  type NotificationOutboxRow,
} from "../repositories/notification-repository.js";

export interface SendLineMessageResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface NotificationDispatcherOptions {
  nodeId: string;
  batchSize: number;
  lockMs: number;
  sendLineMessage: (targetId: string, text: string) => Promise<SendLineMessageResult>;
}

export interface NotificationDispatchLoop {
  stop(): void;
}

const EMPTY_DISPATCH_RESULT = { claimed: 0, sent: 0, failed: 0 };

function validateOptions(options: NotificationDispatcherOptions): string {
  if (typeof options.nodeId !== "string" || !options.nodeId.trim()) {
    throw new Error("nodeId is required");
  }
  if (typeof options.lockMs !== "number" || !Number.isFinite(options.lockMs) || options.lockMs <= 0) {
    throw new Error("lockMs must be greater than 0");
  }
  if (typeof options.sendLineMessage !== "function") {
    throw new Error("sendLineMessage must be a function");
  }
  return options.nodeId.trim();
}

function validateLoopOptions(options: NotificationDispatcherOptions & { intervalMs: number }): void {
  validateOptions(options);
  if (typeof options.intervalMs !== "number" || !Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("intervalMs must be greater than 0");
  }
}

function nextRetryDelayMs(row: NotificationOutboxRow): number {
  const attempt = Math.max(1, row.attempts + 1);
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}

function logStaleLock(row: NotificationOutboxRow, nodeId: string, outcome: "delivered" | "failed"): void {
  logger.warn("notification-dispatch-stale-lock", {
    outboxId: row.id,
    nodeId,
    outcome,
    lockedBy: row.lockedBy,
  });
}

export async function runNotificationDispatchOnce(options: NotificationDispatcherOptions): Promise<{ claimed: number; sent: number; failed: number }> {
  const nodeId = validateOptions(options);
  if (options.batchSize <= 0) return EMPTY_DISPATCH_RESULT;

  const rows = await claimNotificationOutboxBatch(nodeId, options.batchSize, options.lockMs);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const text = `${row.title}\n${row.message}`;
    try {
      const result = await options.sendLineMessage(row.targetId, text);
      if (result.ok) {
        const marked = await markNotificationDelivered(row.id, nodeId, "linejs", result.providerMessageId);
        if (marked) {
          sent += 1;
        } else {
          logStaleLock(row, nodeId, "delivered");
        }
      } else {
        const marked = await markNotificationFailed(row.id, nodeId, result.error || "LINE send failed", nextRetryDelayMs(row));
        if (marked) {
          failed += 1;
        } else {
          logStaleLock(row, nodeId, "failed");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const marked = await markNotificationFailed(row.id, nodeId, message, nextRetryDelayMs(row));
      if (marked) {
        failed += 1;
      } else {
        logStaleLock(row, nodeId, "failed");
      }
      logger.warn("notification-dispatch-send-failed", { outboxId: row.id, error: message });
    }
  }

  return { claimed: rows.length, sent, failed };
}

export function startNotificationDispatchLoop(options: NotificationDispatcherOptions & { intervalMs: number }): NotificationDispatchLoop {
  validateLoopOptions(options);

  let running = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runNotificationDispatchOnce(options);
    } catch (error) {
      logger.warn("notification-dispatch-loop-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
