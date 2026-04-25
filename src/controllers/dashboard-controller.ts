import type { FastifyPluginAsync } from "fastify";
import { buildDashboardHtml } from "../views/dashboard.js";
import { buildLoginHtml } from "../views/login.js";
import { metrics } from "../services/metrics.js";
import { env } from "../config/env.js";
import { getPool } from "../db/client.js";

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
    return {
      status: "ok",
      uptime: snap.uptime,
      lastPoll: snap.lastPoll.timestamp,
      errorRate: snap.polling.totalRequests > 0
        ? Math.round((snap.polling.errorCount / snap.polling.totalRequests) * 100)
        : 0,
    };
  });

  app.get("/ready", async (_req, reply) => {
    try {
      await getPool().query("SELECT 1");
      return { ready: true, checks: { database: "ok" } };
    } catch (error) {
      reply.code(503);
      return {
        ready: false,
        checks: { database: "error" },
        error: env.NODE_ENV === "production" ? "Database check failed" : error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.get("/metrics", async () => metrics.snapshot());
};
