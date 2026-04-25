import type { ServerResponse } from "node:http";
import { logger } from "../utils/logger.js";

export type SseEvent = {
  event: string;
  data: unknown;
};

const MAX_CLIENTS = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;

class SseBroadcaster {
  private clients = new Set<ServerResponse>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Register a new SSE client connection */
  addClient(res: ServerResponse): void {
    if (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.values().next().value;
      if (oldest) this.removeClient(oldest);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(": connected\n\n");
    this.clients.add(res);

    res.on("close", () => this.removeClient(res));

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    logger.info("sse-client-connected", { total: this.clients.size });
  }

  /** Remove a client and clean up if no clients remain */
  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
    try { res.end(); } catch { /* already closed */ }

    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Broadcast an event to all connected clients */
  broadcast(event: SseEvent): void {
    if (this.clients.size === 0) return;

    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const dead: ServerResponse[] = [];

    for (const client of this.clients) {
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

    for (const client of this.clients) {
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
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

/** Singleton SSE broadcaster shared across the app */
export const sseBroadcaster = new SseBroadcaster();
