import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { metrics, type MetricsSnapshot } from "../services/metrics.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { sseBroadcaster } from "../services/sse.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { fetchLineQuota } from "../services/notifier.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { isJtiRevoked } from "../repositories/jwt-blacklist-repository.js";
import { hasRole, type AuthUser, type UserRole, normalizeRole } from "../services/authz.js";

interface AuthTokenLike {
  username?: string;
  id?: number;
  role?: unknown;
  jti?: string;
}

async function authenticate(req: FastifyRequest, reply: FastifyReply, requiredRole: UserRole = "user"): Promise<AuthUser | null> {
  try {
    const decoded = await req.jwtVerify({ onlyCookie: true }) as AuthTokenLike;
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

export function buildDashboardHealthResponse(snap: MetricsSnapshot): {
  statusCode: 200 | 503;
  data: DashboardHealthData;
} {
  const errorRate = snap.polling.totalRequests > 0
    ? Math.round((snap.polling.errorCount / snap.polling.totalRequests) * 100)
    : 0;
  const isHealthy = snap.session.isHealthy;

  return {
    statusCode: isHealthy ? 200 : 503,
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
    return sendSuccess(reply, { ready }, ready ? undefined : "Service unavailable", ready ? 200 : 503);
  });

  // Authenticated — full metrics include database/pool internals and runtime details.
  app.get("/metrics", async (req, reply) => {
    if (!(await authenticate(req, reply))) return;
    return sendSuccess(reply, metrics.snapshot());
  });

  app.get("/events", async (req, reply) => {
    if (!(await authenticate(req, reply))) return;
    reply.hijack();
    sseBroadcaster.addClient(reply.raw);
  });

  app.get<{ Querystring: { limit?: number } }>("/metrics/history", {
    schema: {
      querystring: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
      },
    },
  }, async (req, reply) => {
    if (!(await authenticate(req, reply))) return;
    try {
      const limit = (req.query as { limit?: number }).limit ?? 100;
      const history = await getRecentMetricsSnapshots(limit);
      return sendSuccess(reply, history);
    } catch {
      return sendSuccess(reply, []);
    }
  });

  app.get("/pool-stats", async (req, reply) => {
    if (!(await authenticate(req, reply, "admin"))) return;
    return sendSuccess(reply, getPoolStats() ?? null);
  });

  app.get("/line-quota", async (req, reply) => {
    if (!(await authenticate(req, reply))) return;
    const quota = await fetchLineQuota();
    return sendSuccess(reply, quota);
  });

  app.post("/system/pause", async (req, reply) => {
    const user = await authenticate(req, reply, "admin");
    if (!user) return;
    const { pollerControl } = await import("../services/poller-control.js");
    pollerControl.isPaused = true;
    sseBroadcaster.broadcast({ event: "metrics", data: metrics.snapshot() });
    await insertAuditLog(user.username, "Pause Poller", "Paused SPX polling");
    return sendSuccess(reply, { paused: true });
  });

  app.post("/system/resume", async (req, reply) => {
    const user = await authenticate(req, reply, "admin");
    if (!user) return;
    const { pollerControl } = await import("../services/poller-control.js");
    pollerControl.isPaused = false;
    sseBroadcaster.broadcast({ event: "metrics", data: metrics.snapshot() });
    await insertAuditLog(user.username, "Resume Poller", "Resumed SPX polling");
    return sendSuccess(reply, { paused: false });
  });
};
