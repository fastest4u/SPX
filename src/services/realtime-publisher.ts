import { metrics } from "./metrics.js";
import { runtimeMetricsSummaryReadModelFromRecords } from "./runtime-metrics.js";
import {
  createRealtimeEnvelope,
  type RealtimeEnvelopeV1,
  type RealtimePublisher,
  type RealtimePublishInput,
  type RealtimePublishResult,
} from "./realtime-contract.js";
import { persistRealtimeEnvelope, type PersistRealtimeEnvelopeResult } from "../repositories/realtime-event-repository.js";
import { listMergedRealtimeMetricsReadModels, projectRealtimeObservationsEnvelope } from "../repositories/realtime-execution-metrics-repository.js";
import { SignedHttpRealtimePublisher } from "./realtime-http-client.js";
import { sseBroadcaster } from "./sse.js";

export interface LegacyRealtimeEvent {
  event: string;
  data: unknown;
  teamId?: number;
  adminOnly?: boolean;
}

export interface RealtimeTransport {
  publishEnvelope(envelope: RealtimeEnvelopeV1): Promise<void> | void;
  publishLegacy(event: LegacyRealtimeEvent): Promise<void> | void;
}

export interface SseRealtimeBroadcaster {
  broadcastEnvelope(envelope: RealtimeEnvelopeV1<unknown>): void;
  broadcast(event: { event: string; data: unknown; teamId?: number }): void;
  broadcastAdmin(event: { event: string; data: unknown }): void;
}

export class InProcessRealtimePublisher implements RealtimePublisher {
  constructor(private readonly transport: RealtimeTransport) {}

  async publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    const envelope = createRealtimeEnvelope(input);
    await this.transport.publishEnvelope(envelope);
    return {
      accepted: true,
      duplicate: false,
      id: envelope.id,
      receivedAt: envelope.receivedAt,
      persisted: false,
    };
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish({
      ...input,
      replayable: input.replayable ?? false,
    });
  }

  async publishLegacy(event: LegacyRealtimeEvent): Promise<void> {
    await this.transport.publishLegacy(event);
  }
}

export interface PersistentRealtimePublisherOptions {
  persistEnvelope?: (envelope: RealtimeEnvelopeV1<unknown>) => Promise<PersistRealtimeEnvelopeResult>;
  projectEnvelope?: (envelope: RealtimeEnvelopeV1<unknown>) => Promise<unknown> | unknown;
  onTransportError?: (error: unknown, envelope: RealtimeEnvelopeV1<unknown>) => void;
}

function storedEnvelopeReceivedAt(row: PersistRealtimeEnvelopeResult["row"]): string {
  try {
    const parsed = JSON.parse(row.envelopeJson) as { receivedAt?: unknown };
    if (typeof parsed.receivedAt === "string") return parsed.receivedAt;
  } catch {
    // Fall through to the database timestamp projection.
  }

  if (row.receivedAt instanceof Date) return row.receivedAt.toISOString();
  if (typeof row.receivedAt === "string") {
    const parsed = new Date(row.receivedAt);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

export class PersistentRealtimePublisher implements RealtimePublisher {
  private readonly persistEnvelope: (envelope: RealtimeEnvelopeV1<unknown>) => Promise<PersistRealtimeEnvelopeResult>;

  constructor(
    private readonly transport: RealtimeTransport,
    options: PersistentRealtimePublisherOptions = {},
  ) {
    this.persistEnvelope = options.persistEnvelope ?? persistRealtimeEnvelope;
    this.projectEnvelope = options.projectEnvelope;
    this.onTransportError = options.onTransportError;
  }

  private readonly projectEnvelope?: (envelope: RealtimeEnvelopeV1<unknown>) => Promise<unknown> | unknown;
  private readonly onTransportError?: (error: unknown, envelope: RealtimeEnvelopeV1<unknown>) => void;

  async publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    const envelope = createRealtimeEnvelope(input);
    await this.projectEnvelope?.(envelope);

    if (!envelope.replayable) {
      try {
        await this.transport.publishEnvelope(envelope);
      } catch (error) {
        this.onTransportError?.(error, envelope);
      }

      return {
        accepted: true,
        duplicate: false,
        id: envelope.id,
        receivedAt: envelope.receivedAt,
        persisted: false,
      };
    }

    const persisted = await this.persistEnvelope(envelope);

    if (!persisted.duplicate) {
      try {
        await this.transport.publishEnvelope(envelope);
      } catch (error) {
        this.onTransportError?.(error, envelope);
      }
    }

    return {
      accepted: true,
      duplicate: persisted.duplicate,
      id: persisted.row.eventId,
      receivedAt: persisted.duplicate ? storedEnvelopeReceivedAt(persisted.row) : envelope.receivedAt,
      persisted: true,
    };
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish({
      ...input,
      replayable: input.replayable ?? false,
    });
  }

  async publishLegacy(event: LegacyRealtimeEvent): Promise<void> {
    await this.transport.publishLegacy(event);
  }
}

export function createInProcessRealtimePublisher(
  transport: RealtimeTransport = createSseRealtimeTransport(),
): InProcessRealtimePublisher {
  return new InProcessRealtimePublisher(transport);
}

export function createPersistentRealtimePublisher(
  transport: RealtimeTransport = createSseRealtimeTransport(),
  options: PersistentRealtimePublisherOptions = {},
): PersistentRealtimePublisher {
  return new PersistentRealtimePublisher(transport, options);
}

export function createPersistentInProcessRealtimePublisher(
  transport: RealtimeTransport = createSseRealtimeTransport(),
  options: PersistentRealtimePublisherOptions = {},
): PersistentRealtimePublisher {
  return createPersistentRealtimePublisher(transport, {
    ...options,
    projectEnvelope: options.projectEnvelope ?? projectRealtimeObservationsEnvelope,
  });
}

export function createSseRealtimeTransport(
  broadcaster: SseRealtimeBroadcaster = sseBroadcaster,
): RealtimeTransport {
  return {
    async publishEnvelope(envelope) {
      if (
        (envelope.type === "metrics.snapshot" || envelope.type === "metrics.execution.snapshot")
        && envelope.scope.kind === "team"
      ) {
        const teamId = envelope.scope.teamId;
        const record = (await listMergedRealtimeMetricsReadModels()).find(row => row.teamId === teamId);
        // Execution without primary poll state never manufactures a healthy metrics frame.
        if (!record && envelope.type === "metrics.execution.snapshot") return;
        broadcaster.broadcastEnvelope({
          ...envelope,
          type: "metrics.snapshot",
          payloadVersion: 1,
          payload: record?.snapshot ?? envelope.payload,
        });
        return;
      }
      if (envelope.type === "metrics.aggregate" && envelope.scope.kind === "admin") {
        const records = await listMergedRealtimeMetricsReadModels();
        if (records.length) {
          envelope = {
            ...envelope,
            payload: runtimeMetricsSummaryReadModelFromRecords(
              metrics.snapshot(), records, null, { expectedTeamIds: [], now: Date.now() },
            ).metrics,
          };
        }
      }
      broadcaster.broadcastEnvelope(envelope);
    },
    async publishLegacy(event) {
      if (event.event === "metrics" && typeof event.teamId === "number") {
        const record = (await listMergedRealtimeMetricsReadModels()).find(row => row.teamId === event.teamId);
        if (record) event = { ...event, data: record.snapshot };
      }
      if (typeof event.teamId === "number") {
        broadcaster.broadcast({
          event: event.event,
          teamId: event.teamId,
          data: event.data,
        });
        return;
      }

      if (event.event === "metrics") {
        const records = await listMergedRealtimeMetricsReadModels();
        if (records.length) {
          event = {
            ...event,
            data: runtimeMetricsSummaryReadModelFromRecords(
              metrics.snapshot(), records, null, { expectedTeamIds: [], now: Date.now() },
            ).metrics,
          };
        }
      }
      broadcaster.broadcastAdmin({
        event: event.event,
        data: event.data,
      });
    },
  };
}

export function closeInProcessRealtimeClients(): void {
  sseBroadcaster.closeAll();
}

export interface RuntimeRealtimePublisherOptions {
  /** Remote canonical events endpoint; omit for the in-process local path. */
  url?: string;
  sharedSecret?: string;
  nodeId?: string;
  requestTimeoutMs?: number;
}

/**
 * Selects the process realtime boundary: a configured remote realtime-service
 * endpoint wins (workers and split web-api publish over signed HTTP), and the
 * local in-process persistent publisher keeps single-process compatibility.
 */
export function createRuntimeRealtimePublisher(
  options?: RuntimeRealtimePublisherOptions,
): RealtimePublisher {
  if (options?.url) {
    return new SignedHttpRealtimePublisher({
      url: options.url,
      sharedSecret: options.sharedSecret ?? "",
      nodeId: options.nodeId ?? "",
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }
  return createPersistentInProcessRealtimePublisher();
}

export async function publishRealtimeWithLegacy<TPayload>(
  publisher: RealtimePublisher,
  input: RealtimePublishInput<TPayload>,
  legacyEvents: readonly LegacyRealtimeEvent[] = [],
): Promise<RealtimePublishResult> {
  const result = await publisher.publish(input);
  if (result.duplicate) return result;

  const legacyPublisher = publisher as RealtimePublisher & {
    publishLegacy?: (event: LegacyRealtimeEvent) => Promise<void> | void;
  };
  for (const legacyEvent of legacyEvents) {
    await legacyPublisher.publishLegacy?.(legacyEvent);
  }

  return result;
}
