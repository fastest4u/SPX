import type { FastifyPluginAsync } from "fastify";
import { buildDashboardHtml } from "../views/dashboard.js";
import { buildLoginHtml } from "../views/login.js";
import { metrics } from "../services/metrics.js";
import { env } from "../config/env.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { sseBroadcaster } from "../services/sse.js";

export const dashboardController: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    try {
      if (!req.cookies.token) throw new Error("No token");
      await req.jwtVerify({ onlyCookie: true });
      reply.type("text/html; charset=utf-8").send(buildDashboardHtml());
    } catch {
      reply.type("text/html; charset=utf-8").send(buildLoginHtml());
    }
  });

  app.get("/health", async () => {
    const snap = metrics.snapshot();
    const errorRate = snap.polling.totalRequests > 0
      ? Math.round((snap.polling.errorCount / snap.polling.totalRequests) * 100)
      : 0;

    return {
      status: snap.session.isHealthy ? "ok" : "degraded",
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
    };
  });

  app.get("/ready", async (_req, reply) => {
    const checks: Record<string, string> = {};
    let allOk = true;

    // Check 1: Database connectivity
    try {
      await getPool().query("SELECT 1");
      checks.database = "ok";
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

    if (!allOk) reply.code(503);
    return { ready: allOk, checks, poolStats };
  });

  app.get("/metrics", async () => metrics.snapshot());

  app.get("/events", async (req, reply) => {
    try {
      await req.jwtVerify({ onlyCookie: true });
    } catch {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
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
  }, async (req) => {
    try {
      const limit = (req.query as { limit?: number }).limit ?? 100;
      return await getRecentMetricsSnapshots(limit);
    } catch {
      return [];
    }
  });
};
