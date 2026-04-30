import type { FastifyPluginAsync } from "fastify";
import { metrics } from "../services/metrics.js";
import { env } from "../config/env.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { sseBroadcaster } from "../services/sse.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { fetchLineQuota } from "../services/notifier.js";

export const dashboardController: FastifyPluginAsync = async (app) => {
  app.get("/health", async (req, reply) => {
    const snap = metrics.snapshot();
    const errorRate = snap.polling.totalRequests > 0
      ? Math.round((snap.polling.errorCount / snap.polling.totalRequests) * 100)
      : 0;

    const isHealthy = snap.session.isHealthy;
    const statusCode = isHealthy ? 200 : 503;

    return sendSuccess(reply, {
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
      database: snap.database,
      autoAccept: snap.autoAccept,
    }, undefined, statusCode);
  });

  app.get("/ready", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let allOk = true;

    // Check 1: Database connectivity
    try {
      const pool = getPool();
      if (pool) {
        await pool.query("SELECT 1");
        checks.database = "ok";
      } else {
        checks.database = "memory";
      }
    } catch {
      checks.database = "error";
      allOk = false;
    }

    // Check 2: Connection pool saturation
    const poolStats = getPoolStats();
    if (poolStats) {
      const utilization = poolStats.connectionLimit > 0
        ? Math.round((poolStats.acquiredConnections / poolStats.connectionLimit) * 100)
        : 0;
      checks.pool = utilization > 90 ? "saturated" : utilization > 70 ? "warning" : "ok";
      if (poolStats.queuedRequests > 0) {
        checks.pool = "queued";
      }
    }

    // Check 3: Session health (consecutive API errors)
    const snap = metrics.snapshot();
    checks.session = snap.session.isHealthy ? "ok" : "degraded";

    const statusCode = allOk ? 200 : 503;
    return sendSuccess(reply, { ready: allOk, checks, poolStats }, allOk ? undefined : "Service unavailable", statusCode);
  });

  app.get("/metrics", async (req, reply) => sendSuccess(reply, metrics.snapshot()));

  app.get("/events", async (req, reply) => {
    try {
      await req.jwtVerify({ onlyCookie: true });
    } catch {
      return sendError(reply, 401, "UNAUTHORIZED", "Not authenticated");
    }
    // Hijack the raw response for SSE streaming
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
    try {
      const limit = (req.query as { limit?: number }).limit ?? 100;
      const history = await getRecentMetricsSnapshots(limit);
      return sendSuccess(reply, history);
    } catch {
      return sendSuccess(reply, []);
    }
  });

  app.get("/line-quota", async (_req, reply) => {
    const quota = await fetchLineQuota();
    return reply.send(quota);
  });
};
