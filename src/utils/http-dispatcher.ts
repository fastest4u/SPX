import diagnosticsChannel from "node:diagnostics_channel";
import { Agent } from "undici";
import { env } from "../config/env.js";

/**
 * Shared keep-alive connection pool for every SPX upstream API call.
 *
 * Node's global fetch (undici) uses a ~4s keepAliveTimeout by default, so across
 * the idle gap between polls (POLL_INTERVAL_MS, default 30s) the TCP+TLS socket is
 * closed. The next bidding-list poll — and, when a job finally appears, the
 * request-list and accept hops on the critical path — then each pay a fresh
 * handshake. The SPX upstream does not rate-limit (memory insight
 * "spx-upstream-does-not-rate-limit"), and the confirmed remaining latency floor
 * is the three serial RTTs on the list -> request-list -> accept path. Holding warm
 * pooled connections removes the handshake from those hops; a reused connection is
 * strictly faster-or-equal, never slower. This changes transport only — request
 * shape, headers, retry, and accept semantics are untouched.
 */

// The keep-alive idle timeout must outlast the gap between polls, or the socket
// closes during quiet periods and the next poll pays a fresh handshake. Since
// POLL_INTERVAL_MS is operator-tunable live via the DB-backed Settings, the timeout
// is DERIVED from the current interval (2x headroom) rather than hardcoded, and the
// Agent is rebuilt whenever that interval changes (see reconfigureSpxDispatcher) so
// connections stay warm no matter how the interval is tuned.
const MIN_KEEPALIVE_TIMEOUT_MS = 60_000; // floor: covers fast/competitive polling
const MAX_KEEPALIVE_TIMEOUT_MS = 600_000; // cap (10 min): avoids pinning sockets forever
const KEEPALIVE_INTERVAL_FACTOR = 2; // keep warm across ~2 poll cycles
// Bound concurrent sockets per origin: comfortably above the worst-case burst
// (BOOKING_DETAIL_CONCURRENCY + request-list page fan-out + accepts) while still
// preventing a pathological response from opening unbounded connections.
const MAX_CONNECTIONS_PER_ORIGIN = 64;

function keepAliveTimeoutFor(pollIntervalMs: number): number {
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : MIN_KEEPALIVE_TIMEOUT_MS;
  return Math.min(MAX_KEEPALIVE_TIMEOUT_MS, Math.max(MIN_KEEPALIVE_TIMEOUT_MS, interval * KEEPALIVE_INTERVAL_FACTOR));
}

function createSpxAgent(pollIntervalMs: number): Agent {
  const keepAliveTimeout = keepAliveTimeoutFor(pollIntervalMs);
  return new Agent({
    keepAliveTimeout,
    // Let a server Keep-Alive hint extend (never shorten) the idle window up to the cap.
    keepAliveMaxTimeout: Math.max(keepAliveTimeout, MAX_KEEPALIVE_TIMEOUT_MS),
    connections: MAX_CONNECTIONS_PER_ORIGIN,
    // pipelining is intentionally left at undici's default (1). A non-idempotent
    // POST accept must never share a pipelined connection where it could be
    // reordered or replayed.
  });
}

let currentInterval = env.POLL_INTERVAL_MS;
let currentAgent: Agent = createSpxAgent(currentInterval);

/** The live keep-alive pool. Always returns the current Agent (rebuilt on interval change). */
export function getSpxDispatcher(): Agent {
  return currentAgent;
}

/**
 * Rebuild the pool when the live POLL_INTERVAL_MS changes so the keep-alive window
 * always outlasts the gap between polls. No-ops when the interval is unchanged to
 * avoid needless connection churn. The previous Agent is closed gracefully so any
 * in-flight request finishes on it before its sockets are released.
 */
export function reconfigureSpxDispatcher(pollIntervalMs: number): void {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) return;
  if (pollIntervalMs === currentInterval) return;
  currentInterval = pollIntervalMs;
  const previous = currentAgent;
  currentAgent = createSpxAgent(pollIntervalMs);
  void previous.close().catch(() => {
    void previous.destroy().catch(() => {});
  });
}

// ── Keep-alive effectiveness counter ──────────────────────────────────────────
// undici publishes a "connected" event whenever it opens a *new* socket (i.e. a
// fresh TCP+TLS handshake). Counting these against the total upstream request
// count (tracked in metrics) yields the connection-reuse ratio that proves the
// pool is staying warm. We attribute only connections to the SPX origin host so
// infrequent Discord/LINE/AI fetches on the global dispatcher don't skew it.
let upstreamHost = "";
try {
  upstreamHost = new URL(env.API_URL).hostname;
} catch {
  upstreamHost = "";
}

let newConnectionCount = 0;

try {
  diagnosticsChannel.subscribe("undici:client:connected", (message) => {
    const params = (message as { connectParams?: { hostname?: string; host?: string } }).connectParams;
    const host = params?.hostname ?? params?.host ?? "";
    // No resolvable upstream host => count every new connection rather than zero.
    if (!upstreamHost || host === upstreamHost) {
      newConnectionCount++;
    }
  });
} catch {
  // diagnostics_channel unavailable — counter simply stays at 0.
}

/** Number of fresh TCP+TLS connections opened to the SPX upstream (handshakes). */
export function getUpstreamConnectionCount(): number {
  return newConnectionCount;
}
