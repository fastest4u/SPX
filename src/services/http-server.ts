import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import fastifyFormbody from "@fastify/formbody";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { hasRole, type AuthUser, type UserRole, normalizeRole } from "./authz.js";
import { sendError } from "../utils/response.js";
import { resolve } from "node:path";

import { authController } from "../controllers/auth-controller.js";
import { rulesController } from "../controllers/rules-controller.js";
import { usersController } from "../controllers/users-controller.js";
import { settingsController } from "../controllers/settings-controller.js";
import { historyController } from "../controllers/history-controller.js";
import { auditController } from "../controllers/audit-controller.js";
import { dashboardController } from "../controllers/dashboard-controller.js";
import { reportController } from "../controllers/report-controller.js";
import { biddingController } from "../controllers/bidding-controller.js";
import { notifyController } from "./notify-controller.js";

let app: FastifyInstance | null = null;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_USER = 180;
const RATE_LIMIT_ADMIN = 300;
const AUTH_RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_BUCKET_CLEANUP_INTERVAL_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const requestBuckets = new Map<string, { count: number; resetAt: number }>();
let lastBucketCleanup = 0;
const publicAssetsDir = resolve(process.cwd(), "dist/public");
const spaIndexHtmlPath = resolve(publicAssetsDir, "index.html");
let spaIndexHtmlCache: string | null = null;

function getSpaIndexHtml(): string {
  if (!spaIndexHtmlCache) {
    spaIndexHtmlCache = readFileSync(spaIndexHtmlPath, "utf-8");
  }
  return spaIndexHtmlCache;
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (env.HTTP_ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function getClientKey(request: FastifyRequest): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.ip;
}

function checkRateLimit(key: string, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  if (now - lastBucketCleanup >= RATE_LIMIT_BUCKET_CLEANUP_INTERVAL_MS || requestBuckets.size > MAX_RATE_LIMIT_BUCKETS) {
    pruneExpiredRateLimitBuckets(now);
    lastBucketCleanup = now;
  }

  const current = requestBuckets.get(key);

  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    requestBuckets.set(key, next);
    return { allowed: true, remaining: limit - 1, resetAt: next.resetAt };
  }

  current.count += 1;
  requestBuckets.set(key, current);
  return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count), resetAt: current.resetAt };
}

function pruneExpiredRateLimitBuckets(now: number): void {
  for (const [key, bucket] of requestBuckets) {
    if (bucket.resetAt <= now) {
      requestBuckets.delete(key);
    }
  }

  if (requestBuckets.size <= MAX_RATE_LIMIT_BUCKETS) {
    return;
  }

  const overflow = requestBuckets.size - MAX_RATE_LIMIT_BUCKETS;
  const oldestKeys = [...requestBuckets.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, overflow)
    .map(([key]) => key);

  for (const key of oldestKeys) {
    requestBuckets.delete(key);
  }
}

function applySecurityHeaders(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:;");
}

function sendApiError(reply: FastifyReply, statusCode: number, message: string, code: string, details?: unknown): void {
  sendError(reply, statusCode, code, message, details);
}

function getErrorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400) {
      return statusCode;
    }
  }
  return 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRole(required: UserRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as AuthUser | undefined;
    if (!user || !hasRole(user.role, required)) {
      return sendApiError(reply, 403, "Forbidden", "FORBIDDEN");
    }
  };
}

export async function startHttpServer(port: number): Promise<void> {
  app = Fastify({ logger: false, trustProxy: true });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || isAllowedCorsOrigin(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  });
  await app.register(fastifyCookie, { secret: env.COOKIE_SECRET || undefined });
  await app.register(fastifyJwt, { secret: env.JWT_SECRET, cookie: { cookieName: "token", signed: true } });
  // Serve SPA static files - explicit file paths only (no wildcard)
  await app.register(fastifyStatic, { 
    root: publicAssetsDir, 
    prefix: "/", 
    maxAge: "1h", 
    immutable: false,
    wildcard: false,
  });
  await app.register(fastifyFormbody);

  // Graceful shutdown: close DB pool when Fastify closes
  app.addHook("onClose", async () => {
    const { closePool } = await import("../db/client.js");
    try {
      await closePool();
    } catch {
      // Pool may already be closed
    }
  });

  async function authenticateRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await req.jwtVerify({ onlyCookie: true });
      const user = req.user as Partial<AuthUser> & { role?: unknown };
      req.user = { ...user, role: normalizeRole(user.role) } as AuthUser;
    } catch {
      return sendApiError(reply, 401, "Unauthorized", "UNAUTHORIZED");
    }
  }

  app.decorate("authenticate", authenticateRequest);

  app.decorate("requireRole", requireRole);

  app.addHook("onRequest", async (request, reply) => {
    applySecurityHeaders(reply);

    const requestId = randomUUID();
    reply.header("X-Request-Id", requestId);
    (request as FastifyRequest & { startTime?: number }).startTime = Date.now();

    const isApiRequest = request.url.startsWith("/api/");
    const isSpaAssetRequest = request.url === "/" || request.url === "/login" || request.url.startsWith("/assets/") || request.url === "/favicon.ico" || request.url === "/vite.svg";

    if (!isApiRequest || isSpaAssetRequest) {
      return;
    }

    const limit = request.url.startsWith("/api/login") ? AUTH_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
    const rateLimit = checkRateLimit(getClientKey(request), limit);

    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(rateLimit.remaining));
    reply.header("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));

    if (!rateLimit.allowed) {
      return sendApiError(reply, 429, "Too many requests", "RATE_LIMITED", { retryAfterMs: Math.max(0, rateLimit.resetAt - Date.now()) });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as FastifyRequest & { startTime?: number }).startTime;
    const durationMs = typeof startTime === "number" ? Date.now() - startTime : 0;
    logger.info(`${request.method} ${request.url} ${reply.statusCode} ${durationMs}ms`);
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const statusCode = getErrorStatusCode(error);
    const message = getErrorMessage(error);
    if (statusCode >= 500) logger.error(error instanceof Error ? error : new Error(message)); else logger.warn("request-error", { message, statusCode });
    if (reply.sent) return;
    const errorCode = statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR";
    sendApiError(reply, statusCode, statusCode >= 500 ? "Internal server error" : message, errorCode);
  });

  await app.register(authController, { prefix: "/api" });
  await app.register(dashboardController);

  await app.register(async (apiScope) => {
    apiScope.addHook("preHandler", authenticateRequest);
    await apiScope.register(historyController, { prefix: "/history" });
    await apiScope.register(reportController, { prefix: "/reports" });

    await apiScope.register(async (userScope) => {
      userScope.addHook("preHandler", requireRole("user"));
      userScope.addHook("onRequest", async (request, reply) => {
        const rateLimit = checkRateLimit(`role:user:${getClientKey(request)}`, RATE_LIMIT_USER);
        if (!rateLimit.allowed) {
          return sendApiError(reply, 429, "Too many requests", "RATE_LIMITED");
        }
      });
      await userScope.register(rulesController, { prefix: "/rules" });
      await userScope.register(notifyController, { prefix: "/notifications" });
      await userScope.register(biddingController, { prefix: "/bidding" });
    });

    await apiScope.register(async (adminScope) => {
      adminScope.addHook("preHandler", requireRole("admin"));
      // Admins get highest rate limit
      adminScope.addHook("onRequest", async (request, reply) => {
        const rateLimit = checkRateLimit(`role:admin:${getClientKey(request)}`, RATE_LIMIT_ADMIN);
        if (!rateLimit.allowed) {
          return sendApiError(reply, 429, "Too many requests", "RATE_LIMITED");
        }
      });
      await adminScope.register(usersController, { prefix: "/users" });
      await adminScope.register(settingsController, { prefix: "/settings" });
      await adminScope.register(auditController, { prefix: "/audit-logs" });
    });
  }, { prefix: "/api" });

  // SPA catch-all: serve index.html for non-API routes (must be registered after API routes)
  app.get("/*", async (req, reply) => {
    // Skip API routes and root static files
    if (req.url.startsWith("/api/") || req.url.startsWith("/assets/") || req.url.startsWith("/vite.svg") || req.url.startsWith("/metrics") || req.url.startsWith("/health") || req.url.startsWith("/ready") || req.url.startsWith("/events")) {
      return reply.callNotFound();
    }
    // Serve SPA index.html for client-side routes like /history, /users, etc.
    reply.type("text/html; charset=utf-8").send(getSpaIndexHtml());
  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info("http-server-started", { url: `http://localhost:${port}` });
}

export async function stopHttpServer(): Promise<void> {
  if (!app) return;
  await app.close();
  app = null;
  requestBuckets.clear();
  lastBucketCleanup = 0;
}
