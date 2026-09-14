import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";
import {
  REALTIME_ENVELOPE_VERSION,
  serializeSseEnvelope,
  type RealtimeEnvelopeV1,
  type RealtimeSource,
} from "./realtime-contract.js";
import { onRealtimeEventPersisted } from "../repositories/realtime-event-repository.js";

export type SseEvent = {
  teamId?: number;
  event: string;
  data: unknown;
};

export interface TeamSseEvent<T> {
  teamId: number;
  event: string;
  data: T;
}

export interface SseClientScope {
  teamId: number | null;
}

export type SseGuardedWrite = (chunk: string) => Promise<void>;

export interface SseReplayContext {
  deliveredEventIds: Set<string>;
}

export interface SseAddClientOptions {
  preflight?: () => Promise<void>;
  resyncSource?: RealtimeSource;
  replay?: (write: SseGuardedWrite) => Promise<unknown>;
  afterReplay?: (
    write: SseGuardedWrite,
    replayResult: unknown,
    context: SseReplayContext,
  ) => Promise<unknown>;
}

export type SseAddClientResult =
  | { accepted: true }
  | { accepted: false; reason: "capacity" | "closed" };

type SseClientMode = "preflight" | "replaying" | "live";

interface SseClientEntry {
  response: ServerResponse;
  scope: SseClientScope;
  mode: SseClientMode;
  resyncSource: RealtimeSource | undefined;
  buffered: string[];
  bufferedBytes: number;
  bufferedIds: Set<string>;
  pendingResync: boolean;
  semanticResync: boolean;
  deliveredIds: Set<string>;
  drainTimer: unknown | null;
  closed: boolean;
}

export interface SseBroadcasterOptions {
  maxClients?: number;
  maxReplayBufferChunks?: number;
  maxReplayBufferBytes?: number;
  slowClientTimeoutMs?: number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

const DEFAULT_MAX_CLIENTS = 50;
const DEFAULT_MAX_REPLAY_BUFFER_CHUNKS = 64;
const DEFAULT_MAX_REPLAY_BUFFER_BYTES = 256 * 1024;
const DEFAULT_SLOW_CLIENT_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const DEFAULT_RESYNC_SOURCE: RealtimeSource = {
  service: "web-api",
  nodeId: "web-api",
  role: "web-api",
};

/**
 * Resync control frame is a canonical read-model envelope serialized with a
 * reset event id so browsers drop any remembered LastEventId and the frontend
 * read model refetches state.
 */
function buildResyncFrame(entry: SseClientEntry, reason: string): string {
  const now = new Date().toISOString();
  const envelope: RealtimeEnvelopeV1<unknown> = {
    envelopeVersion: REALTIME_ENVELOPE_VERSION,
    id: `read-model.resync-required:${randomUUID()}`,
    type: "read-model.resync-required",
    payloadVersion: 1,
    payload: { reason },
    source: entry.resyncSource ?? DEFAULT_RESYNC_SOURCE,
    scope: entry.scope.teamId === null
      ? { kind: "admin" }
      : { kind: "team", teamId: entry.scope.teamId },
    emittedAt: now,
    receivedAt: now,
    replayable: false,
  };
  return serializeSseEnvelope(envelope, { resetLastEventId: true });
}

export class SseBroadcaster {
  private clients = new Map<ServerResponse, SseClientEntry>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxClients: number;
  private readonly maxReplayBufferChunks: number;
  private readonly maxReplayBufferBytes: number;
  private readonly slowClientTimeoutMs: number;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => unknown;
  private readonly cancelTimeout: (timer: unknown) => void;
  private readonly unsubscribePersisted: () => void;

  constructor(options: SseBroadcasterOptions = {}) {
    this.maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
    this.maxReplayBufferChunks = options.maxReplayBufferChunks ?? DEFAULT_MAX_REPLAY_BUFFER_CHUNKS;
    this.maxReplayBufferBytes = options.maxReplayBufferBytes ?? DEFAULT_MAX_REPLAY_BUFFER_BYTES;
    this.slowClientTimeoutMs = options.slowClientTimeoutMs ?? DEFAULT_SLOW_CLIENT_TIMEOUT_MS;
    this.scheduleTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer as never));
    // Persisted canonical envelopes are buffered for clients still in their
    // preflight/replay window; live delivery happens through the publisher.
    this.unsubscribePersisted = onRealtimeEventPersisted((envelope) => {
      this.bufferPersistedEnvelope(envelope);
    });
  }

  /**
   * Register a new SSE client. The returned promise resolves only after the
   * optional preflight and replay phases complete; a client that disconnects,
   * overflows its replay buffer, or is rejected for capacity never enters the
   * live fan-out set.
   */
  async addClient(
    res: ServerResponse,
    scope: SseClientScope = { teamId: null },
    options: SseAddClientOptions = {},
  ): Promise<SseAddClientResult> {
    if (this.clients.size >= this.maxClients) {
      this.rejectCapacity(res);
      return { accepted: false, reason: "capacity" };
    }

    const entry: SseClientEntry = {
      response: res,
      scope,
      mode: options.preflight ? "preflight" : options.replay ? "replaying" : "live",
      resyncSource: options.resyncSource,
      buffered: [],
      bufferedBytes: 0,
      bufferedIds: new Set<string>(),
      pendingResync: false,
      semanticResync: false,
      deliveredIds: new Set<string>(),
      drainTimer: null,
      closed: false,
    };
    this.clients.set(res, entry);
    res.on("close", () => {
      entry.closed = true;
      this.detachClient(entry);
    });
    res.on("error", () => {
      entry.closed = true;
      this.detachClient(entry);
    });
    res.on("drain", () => {
      if (entry.drainTimer !== null) {
        this.cancelTimeout(entry.drainTimer);
        entry.drainTimer = null;
      }
    });

    if (options.preflight) {
      try {
        await options.preflight();
      } catch {
        this.detachClient(entry);
        return { accepted: false, reason: "closed" };
      }
      if (entry.closed) {
        this.detachClient(entry);
        return { accepted: false, reason: "closed" };
      }
      if (this.countLiveOrPending() > this.maxClients) {
        this.detachClient(entry);
        this.rejectCapacity(res);
        return { accepted: false, reason: "capacity" };
      }
      entry.mode = options.replay ? "replaying" : "live";
    }

    res.writeHead(200, SSE_HEADERS);
    res.write(": connected\n\n");
    res.write("retry: 5000\n\n");

    if (options.replay) {
      const write: SseGuardedWrite = async (chunk: string): Promise<void> => {
        if (entry.closed) throw new Error("sse-client-closed");
        this.writeGuarded(entry, chunk);
        if (entry.closed) throw new Error("sse-client-closed");
        const frameId = frameEventId(chunk);
        if (frameId !== undefined) entry.deliveredIds.add(frameId);
        if (chunk.startsWith("id:\nevent: read-model.resync-required\n")) {
          // The replay layer already delivered its own semantic resync frame;
          // close quietly instead of emitting a duplicate control frame.
          entry.semanticResync = true;
          entry.closed = true;
          this.detachClient(entry, true);
          throw new Error("sse-client-resync-required");
        }
      };
      let replayResult: unknown;
      try {
        replayResult = await options.replay(write);
      } catch {
        if (!entry.closed && !entry.semanticResync) this.resyncAndClose(entry);
        return { accepted: false, reason: "closed" };
      }
      if (entry.closed || entry.pendingResync) {
        if (!entry.closed) this.resyncAndClose(entry);
        return { accepted: false, reason: "closed" };
      }
      if (options.afterReplay) {
        let afterResult: unknown;
        try {
          afterResult = await options.afterReplay(write, replayResult, {
            deliveredEventIds: entry.deliveredIds,
          });
        } catch {
          if (!entry.closed && !entry.semanticResync) this.resyncAndClose(entry, "catchup-failed");
          return { accepted: false, reason: "closed" };
        }
        if (entry.closed || entry.pendingResync) {
          if (!entry.closed) this.resyncAndClose(entry);
          return { accepted: false, reason: "closed" };
        }
        if (
          afterResult !== null
          && typeof afterResult === "object"
          && "caughtUp" in afterResult
          && (afterResult as { caughtUp?: unknown }).caughtUp === false
        ) {
          // An unproven catch-up must fail closed so the client refetches its
          // read model instead of silently living behind the backlog.
          this.resyncAndClose(entry, "catchup-incomplete");
          return { accepted: false, reason: "closed" };
        }
      }
      entry.mode = "live";
    }

    if (entry.pendingResync) {
      this.resyncAndClose(entry);
      return { accepted: false, reason: "closed" };
    }

    for (const chunk of entry.buffered) {
      const frameId = frameEventId(chunk);
      if (frameId !== undefined && entry.deliveredIds.has(frameId)) continue;
      this.writeGuarded(entry, chunk);
      if (frameId !== undefined) entry.deliveredIds.add(frameId);
      if (entry.closed) return { accepted: false, reason: "closed" };
    }
    entry.buffered = [];
    entry.bufferedBytes = 0;
    entry.bufferedIds.clear();

    this.ensureHeartbeat();
    logger.info("sse-client-connected", { total: this.clients.size, teamId: scope.teamId });
    metrics.recordRuntimeState({ sseClients: this.clients.size });
    return { accepted: true };
  }

  /** Remove a client and clean up if no clients remain */
  removeClient(res: ServerResponse): void {
    const entry = this.clients.get(res);
    if (entry) {
      this.detachClient(entry);
    }
    try { res.end(); } catch { /* already closed */ }
    metrics.recordRuntimeState({ sseClients: this.clients.size });
  }

  /** Broadcast a legacy event to all connected live clients */
  broadcast(event: SseEvent): void {
    if (this.clients.size === 0) return;

    const data = typeof event.teamId === "number"
      ? { teamId: event.teamId, event: event.event, data: event.data }
      : event.data;
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.deliver(payload, (scope) =>
      typeof event.teamId !== "number" || scope.teamId === null || scope.teamId === event.teamId,
    );
  }

  /** Broadcast only to admin/all-team clients. */
  broadcastAdmin(event: Omit<SseEvent, "teamId">): void {
    if (this.clients.size === 0) return;

    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    this.deliver(payload, (scope) => scope.teamId === null);
  }

  /** Broadcast a canonical realtime envelope to matching live clients. */
  broadcastEnvelope(envelope: RealtimeEnvelopeV1<unknown>): void {
    if (this.clients.size === 0) return;
    const payload = serializeSseEnvelope(envelope);
    this.deliver(payload, (scope) => envelopeMatchesScope(envelope, scope));
  }

  /**
   * Buffer a freshly persisted canonical envelope for clients still inside
   * their preflight/replay window. Live clients are skipped: their delivery
   * happens through the publisher fan-out that triggered the persistence.
   */
  private bufferPersistedEnvelope(envelope: RealtimeEnvelopeV1<unknown>): void {
    if (this.clients.size === 0) return;
    const payload = serializeSseEnvelope(envelope);
    for (const entry of [...this.clients.values()]) {
      if (entry.closed || entry.mode === "live") continue;
      if (!envelopeMatchesScope(envelope, entry.scope)) continue;
      if (envelope.id && entry.deliveredIds.has(envelope.id)) continue;
      this.bufferDuringReplay(entry, payload);
    }
  }

  private deliver(payload: string, matches: (scope: SseClientScope) => boolean): void {
    for (const entry of [...this.clients.values()]) {
      if (entry.closed) continue;
      if (!matches(entry.scope)) continue;
      if (entry.mode === "live") {
        this.writeGuarded(entry, payload);
      } else {
        this.bufferDuringReplay(entry, payload);
      }
    }
  }

  /**
   * Guarded per-client write: backpressured sockets get exactly one drain
   * window; a second write while the window is open, or a window that times
   * out, terminates that client with a reset-id resync frame instead of
   * letting slow readers stall producers.
   */
  private writeGuarded(entry: SseClientEntry, chunk: string): void {
    if (entry.closed) return;
    if (entry.drainTimer !== null) {
      this.resyncAndClose(entry);
      return;
    }
    let ok: boolean;
    try {
      ok = entry.response.write(chunk);
    } catch {
      entry.closed = true;
      this.detachClient(entry);
      return;
    }
    if (!ok) {
      entry.drainTimer = this.scheduleTimeout(() => {
        entry.drainTimer = null;
        this.resyncAndClose(entry);
      }, this.slowClientTimeoutMs);
    }
  }

  private bufferDuringReplay(entry: SseClientEntry, payload: string): void {
    if (entry.pendingResync) return;
    const frameId = frameEventId(payload);
    if (frameId !== undefined) {
      if (entry.bufferedIds.has(frameId) || entry.deliveredIds.has(frameId)) return;
    }
    if (
      entry.buffered.length >= this.maxReplayBufferChunks
      || entry.bufferedBytes + payload.length > this.maxReplayBufferBytes
    ) {
      if (entry.mode === "preflight") {
        // Headers are not written yet; defer the control frame until the
        // preflight completes so the client never sees a frame before 200.
        entry.pendingResync = true;
        return;
      }
      this.resyncAndClose(entry);
      return;
    }
    entry.buffered.push(payload);
    entry.bufferedBytes += payload.length;
    if (frameId !== undefined) entry.bufferedIds.add(frameId);
  }

  private resyncAndClose(entry: SseClientEntry, reason = "slow-client"): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.drainTimer !== null) {
      this.cancelTimeout(entry.drainTimer);
      entry.drainTimer = null;
    }
    try {
      entry.response.write(buildResyncFrame(entry, reason));
      entry.response.end();
    } catch { /* client already gone */ }
    this.detachClient(entry);
  }

  private detachClient(entry: SseClientEntry, end = false): void {
    if (entry.drainTimer !== null) {
      this.cancelTimeout(entry.drainTimer);
      entry.drainTimer = null;
    }
    this.clients.delete(entry.response);
    if (end) {
      try { entry.response.end(); } catch { /* client already gone */ }
    }
    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    metrics.recordRuntimeState({ sseClients: this.clients.size });
  }

  private rejectCapacity(res: ServerResponse): void {
    try {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "SSE_CONNECTION_LIMIT_EXCEEDED",
          message: "SSE connection limit exceeded",
        }),
      );
    } catch { /* client already gone */ }
  }

  private countLiveOrPending(): number {
    return this.clients.size;
  }

  private ensureHeartbeat(): void {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }
  }

  /** Send heartbeat comment to keep connections alive */
  private sendHeartbeat(): void {
    for (const entry of [...this.clients.values()]) {
      if (entry.mode !== "live" || entry.closed) continue;
      this.writeGuarded(entry, ": heartbeat\n\n");
    }
  }

  /** Close all connections and clean up */
  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const entry of this.clients.values()) {
      if (entry.drainTimer !== null) this.cancelTimeout(entry.drainTimer);
      try { entry.response.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    metrics.recordRuntimeState({ sseClients: 0 });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

/** Singleton SSE broadcaster shared across the app */
export const sseBroadcaster = new SseBroadcaster();

function envelopeMatchesScope(envelope: RealtimeEnvelopeV1<unknown>, scope: SseClientScope): boolean {
  if (envelope.scope.kind !== "team") return true;
  return scope.teamId === null || scope.teamId === envelope.scope.teamId;
}

function frameEventId(chunk: string): string | undefined {
  const firstLine = chunk.split("\n", 1)[0] ?? "";
  if (firstLine === "id:") return undefined;
  return /^id: (.+)$/.exec(firstLine)?.[1];
}
