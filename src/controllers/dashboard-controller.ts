import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { metrics, type MetricsSnapshot } from "../services/metrics.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { sseBroadcaster } from "../services/sse.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { fetchLineQuota } from "../services/notifier.js";
import { runtimeMetricsSnapshotFor } from "../services/runtime-metrics.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { isJtiRevoked } from "../repositories/jwt-blacklist-repository.js";
import { hasRole, type AuthUser, type UserRole, normalizeRole } from "../services/authz.js";
import { isTeamPaused, pauseTeam, resumeTeam } from "../services/poller-control.js";
import { env } from "../config/env.js";
import { buildServiceReadiness } from "../services/service-health.js";

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

export const dashboardController: FastifyPluginAsync = async (app) => {
  // Public — load balancer + uptime checks. Returns service health, no internals.
  app.get("/health", async (_req, reply) => {
    const health = buildDashboardHealthResponse(metrics.snapshot());
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
      return sendSuccess(reply, snapshotForUser(user, parseOptionalTeamId(req.query.teamId)));
    },
  );

  app.get("/events", async (req, reply) => {
    const user = await authenticate(req, reply);
    if (!user) return;
    reply.hijack();
    sseBroadcaster.addClient(reply.raw, { teamId: user.role === "admin" ? null : user.teamId });
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
      try {
        const limit = (req.query as { limit?: number }).limit ?? 100;
        const scopedTeamId =
          user.role === "admin"
            ? parseOptionalTeamId(req.query.teamId)
            : (user.teamId ?? undefined);
        const history = await getRecentMetricsSnapshots(limit, scopedTeamId);
        return sendSuccess(reply, history);
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
      sseBroadcaster.broadcast({ event: "metrics", teamId, data: metrics.snapshot({ teamId }) });
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
      sseBroadcaster.broadcast({ event: "metrics", teamId, data: metrics.snapshot({ teamId }) });
      await insertAuditLog(user.username, "Resume Team Poller", `Resumed team ${teamId} polling`, {
        actorUserId: user.id,
        actorTeamId: user.teamId,
        targetTeamId: teamId,
      });
      return sendSuccess(reply, { teamId, paused: isTeamPaused(teamId) });
    },
  );
};
