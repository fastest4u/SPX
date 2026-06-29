import { env } from "../config/env.js";
import { buildAutoAcceptEventKey, type NotificationEventInput } from "./notification-events.js";
import { publishNotificationEvent, sendSpooledNotificationEvent } from "./notification-client.js";
import { NotificationSpool } from "./notification-spool.js";

export interface PublishEnvelope {
  eventKey: string;
  event: NotificationEventInput;
}

export interface AutoAcceptOwnedInput {
  teamId: number;
  teamName: string;
  bookingId: number | string;
  requestIds: Array<number | string>;
  traceId?: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface NotificationPublisher {
  publish(envelope: PublishEnvelope): Promise<{ ok: boolean; error?: string }>;
  autoAcceptOwned(input: AutoAcceptOwnedInput): Promise<{ ok: boolean; error?: string }>;
}

export interface CreateNotificationPublisherOptions {
  publish(envelope: PublishEnvelope): Promise<{ ok: boolean; error?: string }>;
}

function requireRequestIds(requestIds: Array<number | string>): string[] {
  if (requestIds.length === 0) throw new Error("requestIds must contain at least one id");
  return requestIds.map((requestId) => String(requestId));
}

export function buildAutoAcceptOwnedEvent(input: AutoAcceptOwnedInput): PublishEnvelope {
  const bookingId = String(input.bookingId);
  const requestIds = requireRequestIds(input.requestIds);
  const event: NotificationEventInput = {
    schemaVersion: 1,
    eventType: "auto_accept_result",
    severity: "success",
    teamId: input.teamId,
    teamName: input.teamName,
    bookingId,
    requestIds,
    status: "owned",
    reasonCode: "verified_owned",
    traceId: input.traceId,
    message: input.message,
    occurredAt: new Date().toISOString(),
    evidence: input.evidence,
  };

  return {
    eventKey: buildAutoAcceptEventKey({
      status: "owned",
      teamId: input.teamId,
      bookingId,
      requestId: requestIds[0]!,
    }),
    event,
  };
}

export function createNotificationPublisher(options: CreateNotificationPublisherOptions): NotificationPublisher {
  return {
    publish(envelope) {
      return options.publish(envelope);
    },
    autoAcceptOwned(input) {
      return options.publish(buildAutoAcceptOwnedEvent(input));
    },
  };
}

let workerSpoolDrainStarted = false;

function startWorkerSpoolDrainLoop(spool: NotificationSpool): void {
  if (workerSpoolDrainStarted) return;
  workerSpoolDrainStarted = true;

  const drainOnce = async () => {
    await spool.flush(async (entry) => {
      const result = await sendSpooledNotificationEvent({
        entry,
        sharedSecret: env.NOTIFIER_SHARED_SECRET,
        nodeId: env.SPX_NODE_ID,
        requestTimeoutMs: env.NOTIFIER_REQUEST_TIMEOUT_MS,
      });
      return result.ok;
    });
  };

  const intervalMs = Math.max(1000, env.NOTIFIER_RETRY_BASE_DELAY_MS);
  const timer = setInterval(() => {
    drainOnce().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  void drainOnce().catch(() => undefined);
}

export function createWorkerNotificationPublisher(): NotificationPublisher {
  const spool = new NotificationSpool(env.NOTIFIER_LOCAL_SPOOL_PATH, {
    baseDelayMs: env.NOTIFIER_RETRY_BASE_DELAY_MS,
    maxAttempts: env.NOTIFIER_RETRY_MAX_ATTEMPTS,
  });
  startWorkerSpoolDrainLoop(spool);
  return createNotificationPublisher({
    publish: async (envelope) => {
      const result = await publishNotificationEvent({
        url: env.NOTIFIER_API_URL,
        sharedSecret: env.NOTIFIER_SHARED_SECRET,
        nodeId: env.SPX_NODE_ID,
        eventKey: envelope.eventKey,
        event: envelope.event,
        spool,
        requestTimeoutMs: env.NOTIFIER_REQUEST_TIMEOUT_MS,
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  });
}
