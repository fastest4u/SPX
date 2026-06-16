import type { ServerResponse } from "node:http";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";

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

interface SseClientScope {
  teamId: number | null;
}

const MAX_CLIENTS = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;

class SseBroadcaster {
  private clients = new Map<ServerResponse, SseClientScope>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Register a new SSE client connection */
  addClient(res: ServerResponse, scope: SseClientScope = { teamId: null }): void {
    if (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest) this.removeClient(oldest);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(": connected\n\n");
    this.clients.set(res, scope);

    res.on("close", () => this.removeClient(res));

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    logger.info("sse-client-connected", { total: this.clients.size, teamId: scope.teamId });
    metrics.recordRuntimeState({ sseClients: this.clients.size });
  }

  /** Remove a client and clean up if no clients remain */
  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
    try { res.end(); } catch { /* already closed */ }

    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    metrics.recordRuntimeState({ sseClients: this.clients.size });
  }

  /** Broadcast an event to all connected clients */
  broadcast(event: SseEvent): void {
    if (this.clients.size === 0) return;

    const data = typeof event.teamId === "number"
      ? { teamId: event.teamId, event: event.event, data: event.data }
      : event.data;
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead: ServerResponse[] = [];

    for (const [client, scope] of this.clients) {
      if (typeof event.teamId === "number" && scope.teamId !== null && scope.teamId !== event.teamId) {
        continue;
      }
      try {
        if (client.writableEnded || client.destroyed) {
          dead.push(client);
          continue;
        }
        client.write(payload);
      } catch {
        dead.push(client);
      }
    }

    for (const client of dead) {
      this.removeClient(client);
    }
  }

  /** Send heartbeat comment to keep connections alive */
  private sendHeartbeat(): void {
    const dead: ServerResponse[] = [];

    for (const client of this.clients.keys()) {
      try {
        if (client.writableEnded || client.destroyed) {
          dead.push(client);
          continue;
        }
        client.write(": heartbeat\n\n");
      } catch {
        dead.push(client);
      }
    }

    for (const client of dead) {
      this.removeClient(client);
    }
  }

  /** Close all connections and clean up */
  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients.keys()) {
      try { client.end(); } catch { /* ignore */ }
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
