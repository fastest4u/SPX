import { listMergedRealtimeMetricsReadModels } from "../repositories/realtime-execution-metrics-repository.js";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { metrics, type MetricsSnapshot } from "../services/metrics.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { sseBroadcaster } from "../services/sse.js";
import type { RealtimePublisher, RealtimeSource, RealtimeScope } from "../services/realtime-contract.js";
import type {
  RealtimeReadGateway,
  RealtimeReadRequestBody,
  RealtimeStreamRelayResult,
} from "../services/realtime-service-client.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { fetchLineQuota } from "../services/notifier.js";
import { runtimeMetricsSnapshotFor, runtimeMetricsSummaryReadModelFromRecords } from "../services/runtime-metrics.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { isJtiRevoked } from "../repositories/jwt-blacklist-repository.js";
import { hasRole, type AuthUser, type UserRole, normalizeRole } from "../services/authz.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "../services/poller-control.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { buildServiceReadiness } from "../services/service-health.js";

export interface DashboardControllerOptions {
  realtimePublisher?: RealtimePublisher;
  realtimeSource?: RealtimeSource;
  realtimeReadGateway?: RealtimeReadGateway;
}

function defaultDashboardRealtimeSource(): RealtimeSource {
  return {
    service: "web-api",
    nodeId: env.SPX_NODE_ID || "web-api",
    role: env.SPX_ROLE,
  };
}

type DashboardRealtimeScope = RealtimeScope;

function realtimeScopeForUser(
  user: AuthUser,
  queryTeamId: number | null | undefined,
): DashboardRealtimeScope | null {
  const teamId = typeof queryTeamId === "number" ? queryTeamId : undefined;
  if (user.role === "admin") {
    return typeof teamId === "number"
      ? { kind: "team", teamId }
      : { kind: "admin" };
  }
  return typeof user.teamId === "number" ? { kind: "team", teamId: user.teamId } : null;
}

function isMetricsSnapshotShape(value: unknown): value is MetricsSnapshot {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<MetricsSnapshot>;
  return (
    (candidate.teamId === null || typeof candidate.teamId === "number")
    && typeof candidate.uptime === "number"
    && candidate.polling !== null
    && typeof candidate.polling === "object"
    && typeof (candidate.polling as { totalRequests?: unknown }).totalRequests === "number"
    && candidate.data !== null
    && typeof candidate.data === "object"
    && candidate.runtime !== null
    && typeof candidate.runtime === "object"
  );
}

/**
 * Fail-closed validation of a remote metrics read model: the snapshot must be
 * present, the freshness must not report the read model missing, and the
 * snapshot must carry the full public shape. Anything else is a 503 instead of
 * a partially invented dashboard value.
 */
function validatedRemoteMetricsSnapshot(summary: unknown): MetricsSnapshot {
  if (summary === null || typeof summary !== "object") {
    throw new Error("malformed metrics summary");
  }
  const candidate = summary as { metrics?: unknown; freshness?: { status?: unknown } };
  if (candidate.freshness?.status === "missing") {
    throw new Error("metrics read model is missing");
  }
  if (!isMetricsSnapshotShape(candidate.metrics)) {
    throw new Error("malformed metrics snapshot");
  }
  return candidate.metrics;
}

const HISTORY_ROW_FIELDS = [
  "id",
  "teamId",
  "uptime",
  "totalRequests",
  "successCount",
  "errorCount",
  "successRate",
  "latencyAvg",
  "latencyP95",
  "latencyP99",
  "totalRecordsSeen",
  "changesDetected",
  "tripsInserted",
  "tripsSkipped",
  "createdAt",
] as const;

/**
 * History rows are projected onto a fixed allowlist so upstream internals
 * (debug fields, secrets) can never reach the browser. Team scopes also
 * reject cross-team rows rather than silently serving another team's data.
 */
function sanitizedHistoryRow(scope: DashboardRealtimeScope, row: unknown): Record<string, unknown> {
  if (row === null || typeof row !== "object") {
    throw new Error("malformed history row");
  }
  const source = row as Record<string, unknown>;
  if (scope.kind === "team" && source.teamId !== scope.teamId) {
    throw new Error("cross-team history row");
  }
  const result: Record<string, unknown> = {};
  for (const field of HISTORY_ROW_FIELDS) {
    result[field] = source[field] ?? null;
  }
  return result;
}

/**
 * Relays a dashboard SSE subscription through the realtime read gateway.
 * A browser that disconnects before the upstream connection is established
 * must never receive writes on its destroyed response.
 */
export async function relayDashboardRealtimeStream(input: {
  gateway: RealtimeReadGateway;
  body: RealtimeReadRequestBody;
  downstream: ServerResponse;
}): Promise<RealtimeStreamRelayResult> {
  if (input.downstream.destroyed || input.downstream.writableEnded) {
    return { connected: false, status: 499 };
  }
  try {
    return await input.gateway.relayStream({
      body: input.body,
      downstream: input.downstream,
    });
  } catch {
    return { connected: false, status: 503 };
  }
}

/**
 * Publishes the canonical non-replayable team-scoped metrics snapshot first,
 * then the legacy `metrics` SSE event. A canonical publisher failure is logged
 * and suppresses the legacy event so callers never observe a partial
 * dual-emission.
 */
export async function publishDashboardMetricsSnapshot(
  teamId: number,
  snapshot: MetricsSnapshot,
  options: { publisher: RealtimePublisher; source?: RealtimeSource },
): Promise<void> {
  try {
    await options.publisher.publish({
      type: "metrics.snapshot",
      payloadVersion: 1,
      payload: snapshot,
      source: options.source ?? defaultDashboardRealtimeSource(),
      scope: { kind: "team", teamId },
      subject: { type: "team", id: String(teamId), teamId },
      replayable: false,
    });
    const legacyPublisher = options.publisher as RealtimePublisher & {
      publishLegacy?: (event: { event: string; teamId: number; data: MetricsSnapshot }) => Promise<void> | void;
    };
    if (typeof legacyPublisher.publishLegacy === "function") {
      await legacyPublisher.publishLegacy({ event: "metrics", teamId, data: snapshot });
    } else {
      sseBroadcaster.broadcast({ event: "metrics", teamId, data: snapshot });
    }
  } catch (error) {
    logger.warn("dashboard-realtime-publish-failed", {
      teamId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface AuthTokenLike {
  username?: string;
  id?: number;
  role?: unknown;
  teamId?: number | null;
  jti?: string;
}

async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
  requiredRole: UserRole = "user",
): Promise<AuthUser | null> {
  try {
    const decoded = (await req.jwtVerify({ onlyCookie: true })) as AuthTokenLike;
    const role = normalizeRole(decoded.role);
    if (decoded.jti && (await isJtiRevoked(decoded.jti))) {
      sendError(reply, 401, "TOKEN_REVOKED", "Token revoked");
      return null;
    }
    if (!hasRole(role, requiredRole)) {
      sendError(reply, 403, "FORBIDDEN", "Forbidden");
      return null;
    }
    const user: AuthUser = {
      id: typeof decoded.id === "number" ? decoded.id : 0,
      username: typeof decoded.username === "string" ? decoded.username : "unknown",
      role,
      teamId: typeof decoded.teamId === "number" ? decoded.teamId : null,
    };
    req.user = user;
    return user;
  } catch {
    sendError(reply, 401, "UNAUTHORIZED", "Not authenticated");
    return null;
  }
}

interface DashboardHealthData {
  status: "ok" | "degraded";
  uptime: number;
  startedAt: string;
  lastPoll: string | null;
  errorRate: number;
  session: {
    healthy: boolean;
    consecutiveErrors: number;
    lastSessionWarning: string | null;
  };
}

interface TeamScopedQuery {
  teamId?: number | string;
}

function parseOptionalTeamId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function snapshotForUser(user: AuthUser, explicitTeamId?: number): MetricsSnapshot {
  const teamId = user.role === "admin" ? (explicitTeamId ?? null) : user.teamId;
  return runtimeMetricsSnapshotFor(metrics.snapshot({ teamId }), teamId);
}

function resolveOperationalTeamId(user: AuthUser, explicitTeamId?: number): number | null {
  if (user.role === "admin") {
    return typeof explicitTeamId === "number" ? explicitTeamId : null;
  }
  return typeof user.teamId === "number" ? user.teamId : null;
}

export function buildDashboardHealthResponse(snap: MetricsSnapshot): {
  statusCode: 200;
  data: DashboardHealthData;
} {
  const errorRate =
    snap.polling.totalRequests > 0
      ? Math.round((snap.polling.errorCount / snap.polling.totalRequests) * 100)
      : 0;
  const isHealthy = snap.session.isHealthy;

  return {
    statusCode: 200,
    data: {
      status: isHealthy ? "ok" : "degraded",
      uptime: snap.uptime,
      startedAt: snap.startedAt,
      lastPoll: snap.lastPoll.timestamp,
      errorRate,
      session: {
        healthy: snap.session.isHealthy,
        consecutiveErrors: snap.session.consecutiveErrors,
        lastSessionWarning: snap.session.lastSessionWarning,
      },
    },
  };
}

export const dashboardController: FastifyPluginAsync<DashboardControllerOptions> = async (app, options) => {
  // Public — load balancer + uptime checks. Returns service health, no internals.
  app.get("/health", async (_req, reply) => {
    const health = buildDashboardHealthResponse(runtimeMetricsSnapshotFor(metrics.snapshot(), null));
    return sendSuccess(reply, health.data, undefined, health.statusCode);
  });

  // Public - deploy/load-balancer readiness. Poller/session health stays in
  // /health so transient upstream SPX errors do not roll back a healthy deploy.
  app.get("/ready", async (_req, reply) => {
    let ready = true;
    try {
      const pool = getPool();
      if (pool) await pool.query("SELECT 1");
    } catch {
      ready = false;
    }

    const readiness = await buildServiceReadiness({
      surface: "web-api",
      role: env.SPX_ROLE,
      nodeId: env.SPX_NODE_ID || "web-api",
      databaseReady: ready,
      lineServiceUrl: env.LINE_SERVICE_URL,
      lineServiceRequestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
      ocrServiceUrl: env.OCR_SERVICE_URL,
      ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
    });
    return sendSuccess(
      reply,
      readiness.data,
      ready ? undefined : "Service unavailable",
      ready ? 200 : 503,
    );
  });

  // Authenticated — full metrics include database/pool internals and runtime details.
  app.get<{ Querystring: TeamScopedQuery }>(
    "/metrics",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { teamId: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const user = await authenticate(req, reply);
      if (!user) return;
      const scope = realtimeScopeForUser(user, parseOptionalTeamId(req.query.teamId));
      if (!scope) {
        return sendError(reply, 403, "TEAM_REQUIRED", "User has no assigned team", { retryable: false });
      }
      if (options.realtimeReadGateway) {
        try {
          const summary = await options.realtimeReadGateway.readMetrics({ scope });
          return sendSuccess(reply, validatedRemoteMetricsSnapshot(summary));
        } catch {
          return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
        }
      }
      if (scope.kind === "team") {
        const record = (await listMergedRealtimeMetricsReadModels()).find(row => row.teamId === scope.teamId);
        if (!record) {
          return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
        }
        return sendSuccess(reply, record.snapshot);
      }
      return sendSuccess(reply, runtimeMetricsSummaryReadModelFromRecords(
        snapshotForUser(user, undefined),
        await listMergedRealtimeMetricsReadModels(),
        null,
        { expectedTeamIds: [], now: Date.now() },
      ).metrics);
    },
  );

  app.get("/events", async (req, reply) => {
    const user = await authenticate(req, reply);
    if (!user) return;
    const scope = realtimeScopeForUser(user, undefined);
    if (!scope) {
      return sendError(reply, 403, "TEAM_REQUIRED", "User has no assigned team", { retryable: false });
    }
    if (options.realtimeReadGateway) {
      const lastEventId = Array.isArray(req.headers["last-event-id"])
        ? req.headers["last-event-id"][0]
        : req.headers["last-event-id"];
      const body: RealtimeReadRequestBody = {
        scope,
        ...(typeof lastEventId === "string" && lastEventId.length > 0 ? { lastEventId } : {}),
      };
      const result = await relayDashboardRealtimeStream({
        gateway: options.realtimeReadGateway,
        body,
        downstream: reply.raw,
      });
      if (!result.connected) {
        return sendError(
          reply,
          result.status === 429 ? 429 : 503,
          "REALTIME_STREAM_UNAVAILABLE",
          "Realtime stream unavailable",
          { retryable: result.status === 429 },
        );
      }
      return;
    }
    reply.hijack();
    void sseBroadcaster.addClient(reply.raw, { teamId: user.role === "admin" ? null : user.teamId });
  });

  app.get<{ Querystring: { limit?: number; teamId?: number | string } }>(
    "/metrics/history",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            teamId: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = await authenticate(req, reply);
      if (!user) return;
      const limit = (req.query as { limit?: number }).limit ?? 100;
      const scope = realtimeScopeForUser(
        user,
        user.role === "admin" ? parseOptionalTeamId(req.query.teamId) : undefined,
      );
      if (!scope) {
        return sendError(reply, 403, "TEAM_REQUIRED", "User has no assigned team", { retryable: false });
      }
      if (options.realtimeReadGateway) {
        try {
          const rows = await options.realtimeReadGateway.readMetricsHistory({ scope, limit });
          if (!Array.isArray(rows)) throw new Error("malformed history");
          return sendSuccess(reply, rows.map((row) => sanitizedHistoryRow(scope, row)));
        } catch {
          return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
        }
      }
      try {
        const scopedTeamId = scope.kind === "team" ? scope.teamId : undefined;
        const history = await getRecentMetricsSnapshots(limit, scopedTeamId);
        return sendSuccess(reply, history.map((row) => sanitizedHistoryRow(scope, row)));
      } catch {
        return sendSuccess(reply, []);
      }
    },
  );

  app.get("/pool-stats", async (req, reply) => {
    if (!(await authenticate(req, reply, "admin"))) return;
    return sendSuccess(reply, getPoolStats() ?? null);
  });

  app.get("/line-quota", async (req, reply) => {
    if (!(await authenticate(req, reply))) return;
    const quota = await fetchLineQuota();
    return sendSuccess(reply, quota);
  });

  const teamControlQuerySchema = {
    type: "object",
    properties: { teamId: { type: "integer", minimum: 1 } },
  } as const;

  app.post<{ Querystring: TeamScopedQuery }>(
    "/system/pause",
    { schema: { querystring: teamControlQuerySchema } },
    async (req, reply) => {
      const user = await authenticate(req, reply);
      if (!user) return;
      const teamId = resolveOperationalTeamId(user, parseOptionalTeamId(req.query.teamId));
      if (teamId === null)
        return sendError(reply, 400, "TEAM_REQUIRED", "Admin requests must include teamId");
      pauseTeam(teamId);
      const snapshot = { ...runtimeMetricsSnapshotFor(metrics.snapshot({ teamId }), teamId), isPaused: true };
      if (options.realtimePublisher) {
        await publishDashboardMetricsSnapshot(teamId, snapshot, {
          publisher: options.realtimePublisher,
          source: options.realtimeSource,
        });
      } else {
        sseBroadcaster.broadcast({ event: "metrics", teamId, data: snapshot });
      }
      await insertAuditLog(user.username, "Pause Team Poller", `Paused team ${teamId} polling`, {
        actorUserId: user.id,
        actorTeamId: user.teamId,
        targetTeamId: teamId,
      });
      return sendSuccess(reply, { teamId, paused: isTeamPaused(teamId) });
    },
  );

  app.post<{ Querystring: TeamScopedQuery }>(
    "/system/resume",
    { schema: { querystring: teamControlQuerySchema } },
    async (req, reply) => {
      const user = await authenticate(req, reply);
      if (!user) return;
      const teamId = resolveOperationalTeamId(user, parseOptionalTeamId(req.query.teamId));
      if (teamId === null)
        return sendError(reply, 400, "TEAM_REQUIRED", "Admin requests must include teamId");
      resumeTeam(teamId);
      const snapshot = { ...runtimeMetricsSnapshotFor(metrics.snapshot({ teamId }), teamId), isPaused: false };
      if (options.realtimePublisher) {
        await publishDashboardMetricsSnapshot(teamId, snapshot, {
          publisher: options.realtimePublisher,
          source: options.realtimeSource,
        });
      } else {
        sseBroadcaster.broadcast({ event: "metrics", teamId, data: snapshot });
      }
      await insertAuditLog(user.username, "Resume Team Poller", `Resumed team ${teamId} polling`, {
        actorUserId: user.id,
        actorTeamId: user.teamId,
        targetTeamId: teamId,
      });
      return sendSuccess(reply, { teamId, paused: isTeamPaused(teamId) });
    },
  );
};
