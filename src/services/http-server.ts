import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyFormbody from "@fastify/formbody";
import { env } from "../config/env.js";
import { getPool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { hasRole, type AuthUser, type UserRole } from "./authz.js";
import { resolveAuthUserFromJwtPayload } from "./auth-session.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { isAppError } from "../utils/errors.js";
import { resolve } from "node:path";
import type { HttpSurface, RuntimeRole } from "./runtime-role.js";
import { buildServiceReadiness } from "./service-health.js";

import { authController } from "../controllers/auth-controller.js";
import { rulesController } from "../controllers/rules-controller.js";
import { usersController } from "../controllers/users-controller.js";
import { settingsController } from "../controllers/settings-controller.js";
import { currentTeamController, teamsController } from "../controllers/teams-controller.js";
import { historyController } from "../controllers/history-controller.js";
import { auditController } from "../controllers/audit-controller.js";
import { dashboardController } from "../controllers/dashboard-controller.js";
import { reportController, auditReportController } from "../controllers/report-controller.js";
import { biddingController } from "../controllers/bidding-controller.js";
import { autoAcceptHistoryController } from "../controllers/auto-accept-history-controller.js";
import { notifyController } from "./notify-controller.js";
import { lineBotController } from "../controllers/line-bot-controller.js";
import { aiController } from "../controllers/ai-controller.js";
import { lineImageExtractionController } from "../controllers/line-image-extraction-controller.js";
import { internalNotificationController } from "../controllers/internal-notification-controller.js";
import { internalLineController } from "../controllers/internal-line-controller.js";
import { internalOcrController } from "../controllers/internal-ocr-controller.js";
import { internalGate6Controller } from "../controllers/internal-gate6-controller.js";
import { internalRealtimeController } from "../controllers/internal-realtime-controller.js";
import { internalRealtimeReadController } from "../controllers/internal-realtime-read-controller.js";
import type { InternalGate6Repository } from "../controllers/internal-gate6-controller.js";
import type { RealtimePublisher } from "./realtime-contract.js";
import type { RealtimeReadGateway } from "./realtime-service-client.js";
import { runtimeStatusController } from "../controllers/runtime-status-controller.js";
import {
  createAdminProviderAuthController,
  createOwnTeamProviderAuthController,
} from "../controllers/provider-auth-controller.js";
import {
  notificationReconciliationController,
  type NotificationReconciliationControllerOptions,
} from "../controllers/notification-reconciliation-controller.js";
import { DurableInternalRequestReplayGuard } from "../repositories/internal-request-replay-repository.js";
import { FileInternalRequestReplayGuard } from "./file-internal-request-replay.js";
import { createOcrAuthRateLimiter } from "./ocr-auth-rate-limit.js";
import { insertAuditLog } from "../repositories/audit-repository.js";

let app: FastifyInstance | null = null;

export interface HttpServerOptions {
  surface: HttpSurface;
  role?: RuntimeRole;
  gate6Repository?: InternalGate6Repository;
  runtimeMetricsRealtimePublisher?: RealtimePublisher;
  realtimeReadGateway?: RealtimeReadGateway;
  loadRealtimeRuntimeStatus?: (scope: unknown) => Promise<unknown>;
  notificationReconciliation?: NotificationReconciliationControllerOptions;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_USER = 180;
const RATE_LIMIT_ADMIN = 300;
const AUTH_RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_BUCKET_CLEANUP_INTERVAL_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const OCR_JSON_BODY_OVERHEAD_BYTES = 4096;
const requestBuckets = new Map<string, { count: number; resetAt: number }>();
let lastBucketCleanup = 0;
const publicAssetsDir = resolve(process.cwd(), "dist/public");
const spaIndexHtmlPath = resolve(publicAssetsDir, "index.html");
let spaIndexHtmlTemplate: string | null = null;

function getSpaIndexTemplate(): string {
  if (!spaIndexHtmlTemplate) {
    spaIndexHtmlTemplate = readFileSync(spaIndexHtmlPath, "utf-8");
  }
  return spaIndexHtmlTemplate;
}

function isProd(): boolean {
  return env.NODE_ENV === "production";
}

function bodyLimitForSurface(surface: HttpSurface): number | undefined {
  if (surface !== "ocr-service") return undefined;
  return Math.ceil((env.CODEX_IMAGE_MAX_BYTES * 4) / 3) + OCR_JSON_BODY_OVERHEAD_BYTES;
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (env.HTTP_ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  // Localhost is only allowed outside production. In production, every origin
  // must be on the explicit allowlist.
  if (isProd()) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function getClientKey(request: FastifyRequest): string {
  // Rate-limit / log identity. Derivation is governed by Fastify's `trustProxy`
  // (configured from HTTP_TRUST_PROXY). Returning request.ip — instead of blindly
  // reading the leftmost X-Forwarded-For entry — means a client can no longer
  // spoof its identity unless the proxy config explicitly trusts that hop.
  return request.ip;
}

function checkRateLimit(
  key: string,
  limit: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  if (
    now - lastBucketCleanup >= RATE_LIMIT_BUCKET_CLEANUP_INTERVAL_MS ||
    requestBuckets.size > MAX_RATE_LIMIT_BUCKETS
  ) {
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
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.resetAt,
  };
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

function applySecurityHeaders(reply: FastifyReply, nonce: string): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Strict transport in production only (avoids HSTS pinning during local HTTP testing)
  if (isProd()) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // CSP — script uses per-request nonce so we drop 'unsafe-inline' for scripts.
  // Style still allows 'unsafe-inline' because Tailwind injects styles at runtime;
  // narrowing further would require a CSS build pipeline change.
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self' 'nonce-${nonce}'`,
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
}

function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code: string,
  details?: unknown,
): void {
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

async function isDatabaseReady(): Promise<boolean> {
  try {
    const pool = getPool();
    if (pool) await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function renderSpaIndex(nonce: string): string {
  const template = getSpaIndexTemplate();
  // Inject nonce on every <script> tag in the template. Vite emits a few of
  // them (the entry script and any inline preamble). Adding a nonce on each
  // is idempotent and matches the CSP header above.
  return template.replace(/<script(?![^>]*\snonce=)/g, `<script nonce="${nonce}"`);
}

async function registerServiceHealthRoutes(
  instance: FastifyInstance,
  surface: HttpSurface,
): Promise<void> {
  instance.get("/health", async (_req, reply) => {
    return sendSuccess(reply, {
      status: "ok",
      service: surface,
      uptime: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
    });
  });

  instance.get("/ready", async (_req, reply) => {
    const lineBot = surface === "line-service" ? await import("./line-bot.js") : null;
    const databaseReady = await isDatabaseReady();
    const readiness = await buildServiceReadiness({
      surface,
      role: env.SPX_ROLE,
      nodeId: env.SPX_NODE_ID || surface,
      databaseReady,
      lineServiceUrl: env.LINE_SERVICE_URL,
      lineServiceRequestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
      ocrServiceUrl: env.OCR_SERVICE_URL,
      ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
      codexImageProvider: env.CODEX_IMAGE_PROVIDER,
      codexImageModel: env.CODEX_IMAGE_MODEL,
      codexImageTimeoutMs: env.CODEX_IMAGE_TIMEOUT_MS,
      codexImageMaxBytes: env.CODEX_IMAGE_MAX_BYTES,
      lineStatus: lineBot?.getStatus(),
      lineImageListenerActive: lineBot?.isImageListenerActive(),
    });
    return sendSuccess(
      reply,
      readiness.data,
      readiness.data.ready ? undefined : "Service unavailable",
      readiness.statusCode,
    );
  });
}

function jwtSecretForRuntime(): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.NODE_ENV === "test") return "test-jwt-secret-minimum-32-characters";
  return env.JWT_SECRET;
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const previousApp = app;
  const databaseReplayGuard = new DurableInternalRequestReplayGuard();
  const ocrAuthRateLimiter = createOcrAuthRateLimiter();
  app = Fastify({
    logger: false,
    trustProxy: env.HTTP_TRUST_PROXY,
    bodyLimit: bodyLimitForSurface(options.surface),
  });

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

  if (options.surface === "web-api") {
    await app.register(fastifyCookie, { secret: env.COOKIE_SECRET || undefined });
    await app.register(fastifyJwt, {
      secret: jwtSecretForRuntime(),
      cookie: { cookieName: "token", signed: true },
    });
    await app.register(fastifyMultipart, {
      limits: {
        fileSize: 25 * 1024 * 1024, // 25MB per file
        files: 1,
        fields: 20,
      },
    });
    // Serve SPA static files - explicit file paths only (no wildcard)
    await app.register(fastifyStatic, {
      root: publicAssetsDir,
      prefix: "/",
      maxAge: "1h",
      immutable: false,
      wildcard: false,
      index: false,
    });
    await app.register(async (instance) => {
      instance.addHook("preHandler", authenticateRequest);
      instance.addHook("preHandler", requireRole("admin"));
      await instance.register(fastifyStatic, {
        root: resolve(process.cwd(), "data", "line-images"),
        prefix: "/line-images/",
        decorateReply: false,
        maxAge: "1h",
        immutable: false,
        wildcard: true,
      });
    });
  }

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
      const decoded = await req.jwtVerify({ onlyCookie: true });
      req.user = await resolveAuthUserFromJwtPayload(decoded);
    } catch (error) {
      const errorCode =
        error instanceof Error && "errorCode" in error
          ? (error as { errorCode?: string }).errorCode
          : undefined;
      if (errorCode === "TOKEN_REVOKED" || errorCode === "TOKEN_INVALID") {
        return sendApiError(
          reply,
          401,
          error instanceof Error ? error.message : "Unauthorized",
          errorCode,
        );
      }
      return sendApiError(reply, 401, "Unauthorized", "UNAUTHORIZED");
    }
  }

  if (options.surface === "web-api") {
    app.decorate("authenticate", authenticateRequest);
    app.decorate("requireRole", requireRole);
  }

  app.addHook("onRequest", async (request, reply) => {
    const nonce = randomBytes(16).toString("base64");
    (request as FastifyRequest & { cspNonce?: string }).cspNonce = nonce;
    applySecurityHeaders(reply, nonce);

    const requestId = randomUUID();
    reply.header("X-Request-Id", requestId);
    (request as FastifyRequest & { startTime?: number }).startTime = Date.now();

    const isApiRequest = request.url.startsWith("/api/");
    const isSpaAssetRequest =
      request.url === "/" ||
      request.url === "/login" ||
      request.url.startsWith("/assets/") ||
      request.url === "/favicon.ico" ||
      request.url === "/vite.svg";

    if (!isApiRequest || isSpaAssetRequest) {
      return;
    }

    // Login uses its own bucket: sharing a counter with general API traffic
    // would let normal dashboard requests exhaust (or dilute) the much
    // stricter brute-force budget.
    const isLoginRequest = request.url.startsWith("/api/login");
    const limit = isLoginRequest ? AUTH_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
    const rateLimit = checkRateLimit(
      `${isLoginRequest ? "login" : "api"}:${getClientKey(request)}`,
      limit,
    );

    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(rateLimit.remaining));
    reply.header("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));

    if (!rateLimit.allowed) {
      return sendApiError(reply, 429, "Too many requests", "RATE_LIMITED", {
        retryAfterMs: Math.max(0, rateLimit.resetAt - Date.now()),
      });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as FastifyRequest & { startTime?: number }).startTime;
    const durationMs = typeof startTime === "number" ? Date.now() - startTime : 0;
    logger.info(`${request.method} ${request.url} ${reply.statusCode} ${durationMs}ms`);
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (isAppError(error)) {
      return sendApiError(reply, error.statusCode, error.message, error.errorCode, error.details);
    }

    const statusCode = getErrorStatusCode(error);
    const message = getErrorMessage(error);
    if (statusCode >= 500) logger.error(error instanceof Error ? error : new Error(message));
    else logger.warn("request-error", { message, statusCode });
    if (reply.sent) return;
    const errorCode = statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR";
    sendApiError(
      reply,
      statusCode,
      statusCode >= 500 ? "Internal server error" : message,
      errorCode,
    );
  });

  const legacyNotificationSurface = options.role === "notifier" || options.role === "combined";
  if (options.surface === "notification-service" || legacyNotificationSurface) {
    await app.register(internalNotificationController, {
      prefix: "/internal",
      sharedSecret: env.NODE_ENV === "production" && env.DEPLOYMENT_MODE !== "legacy"
        ? undefined
        : (env.NOTIFIER_SHARED_SECRET || env.SECRETS_KEY),
      nodeSecrets: env.NOTIFICATION_NODE_SECRETS,
      allowedNodes: env.NOTIFICATION_ALLOWED_NODE_TEAMS,
      replayGuard: databaseReplayGuard,
    });
  }

  if (options.surface === "line-service") {
    const lineBot = await import("./line-bot.js");
    const notifier = await import("./notifier.js");
    await app.register(internalLineController, {
      prefix: "/internal",
      sharedSecret: env.NODE_ENV === "production" && env.DEPLOYMENT_MODE !== "legacy"
        ? undefined
        : env.LINE_SERVICE_SEND_SECRET,
      nodeSecrets: (env.NODE_ENV === "production" && env.DEPLOYMENT_MODE !== "legacy") || env.LINE_SERVICE_SEND_NODE_SECRETS.size > 0
        ? env.LINE_SERVICE_SEND_NODE_SECRETS
        : undefined,
      adminSharedSecret: env.LINE_SERVICE_ADMIN_SECRET,
      sendAllowedNodeIds: env.LINE_SEND_ALLOWED_NODE_IDS.size > 0
        ? env.LINE_SEND_ALLOWED_NODE_IDS
        : undefined,
      adminAllowedNodeIds: env.LINE_ADMIN_ALLOWED_NODE_IDS.size > 0
        ? env.LINE_ADMIN_ALLOWED_NODE_IDS
        : undefined,
      requireOutboxFence: env.NODE_ENV === "production" && env.DEPLOYMENT_MODE !== "legacy",
      replayGuard: databaseReplayGuard,
      line: {
        isEnabled: lineBot.isLineBotEnabled,
        getStatus: lineBot.getStatus,
        sendMessage: notifier.sendLineTargetMessage,
        requestQrLogin: lineBot.requestQrLogin,
        getGroups: lineBot.getGroups,
        getProfile: lineBot.getProfile,
        getStorageHealth: lineBot.getStorageHealth,
        logout: lineBot.logout,
      },
      isListenerActive: lineBot.isImageListenerActive,
    });
  }

  if (options.surface === "ocr-service") {
    const ocrReplayGuard = new FileInternalRequestReplayGuard({
      ledgerDir: env.OCR_REPLAY_LEDGER_DIR,
    });
    await app.register(internalOcrController, {
      prefix: "/internal",
      sharedSecret: env.NODE_ENV === "production" ? undefined : env.NOTIFIER_SHARED_SECRET,
      adminSharedSecret: env.NODE_ENV === "production" ? undefined : env.OCR_SERVICE_ADMIN_SECRET,
      nodeSecrets: env.OCR_NODE_SECRETS,
      readAllowedNodeIds: env.OCR_ALLOWED_LINE_NODE_IDS,
      adminAllowedNodeIds: env.OCR_ADMIN_NODE_IDS,
      replayGuard: ocrReplayGuard,
    });
  }

  if (options.surface === "realtime-service") {
    const resolveSecretForNode = env.REALTIME_NODE_SECRETS.size > 0
      ? (nodeId: string) => env.REALTIME_NODE_SECRETS.get(nodeId)
      : undefined;
    await app.register(internalRealtimeController, {
      prefix: "/internal/realtime",
      sharedSecret: env.REALTIME_SHARED_SECRET || undefined,
      resolveSecretForNode,
      publisher: options.runtimeMetricsRealtimePublisher,
      allowedNodes: env.REALTIME_ALLOWED_NODE_TEAMS,
      adminPublishers: env.REALTIME_ADMIN_NODE_IDS,
      replayGuard: databaseReplayGuard,
    });
    await app.register(internalRealtimeReadController, {
      prefix: "/internal/realtime",
      sharedSecret: env.REALTIME_SHARED_SECRET || undefined,
      resolveSecretForNode,
      trustedNodeIds: env.REALTIME_TRUSTED_NODE_IDS,
      adminNodeIds: env.REALTIME_ADMIN_NODE_IDS,
      allowedNodeTeams: env.REALTIME_ALLOWED_NODE_TEAMS,
      loadRuntimeStatus: (options.loadRealtimeRuntimeStatus ?? (async () => null)) as never,
      replayGuard: databaseReplayGuard,
    });
  }

  if (options.surface === "gate6-control" && options.gate6Repository) {
    await app.register(internalGate6Controller, {
      prefix: "/internal",
      repository: options.gate6Repository,
      repositoryName: env.GATE6_REPOSITORY,
      lineNodeSecrets: env.GATE6_LINE_NODE_SECRETS,
      ocrNodeSecrets: env.GATE6_OCR_NODE_SECRETS,
    });
  }

  if (options.surface !== "web-api") {
    await registerServiceHealthRoutes(app, options.surface);
    const builtApp = app;
    app = previousApp;
    return builtApp;
  }

  await app.register(authController, { prefix: "/api" });

  // Operational endpoints — `/health` and `/ready` stay public for load
  // balancers and monitoring. `/metrics`, `/metrics/history`, `/events`,
  // `/line-quota`, and `/system/*` are now behind authentication and the
  // mutating system controls require admin.
  await app.register(async (opsScope) => {
    await opsScope.register(dashboardController, {
      realtimeReadGateway: options.realtimeReadGateway,
      realtimePublisher: options.runtimeMetricsRealtimePublisher,
    });
  });

  await app.register(
    async (apiScope) => {
      apiScope.addHook("preHandler", authenticateRequest);
      await apiScope.register(historyController, { prefix: "/history" });
      await apiScope.register(autoAcceptHistoryController, { prefix: "/auto-accept-history" });
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
        await userScope.register(currentTeamController, { prefix: "/team" });
        await userScope.register(createOwnTeamProviderAuthController(), { prefix: "/team/provider-auth" });
        await userScope.register(notifyController, { prefix: "/notifications" });
        await userScope.register(biddingController, { prefix: "/bidding" });
        await userScope.register(lineBotController, { prefix: "/line-bot" });
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
        await adminScope.register(teamsController, { prefix: "/teams" });
        await adminScope.register(createAdminProviderAuthController(), { prefix: "/teams" });
        await adminScope.register(usersController, { prefix: "/users" });
        await adminScope.register(settingsController, { prefix: "/settings" });
        await adminScope.register(auditController, { prefix: "/audit-logs" });
        await adminScope.register(auditReportController, { prefix: "/reports" });
        await adminScope.register(runtimeStatusController, {
          prefix: "/runtime",
          realtimeReadGateway: options.realtimeReadGateway,
        });
        await adminScope.register(aiController, {
          prefix: "/ai",
          authRateLimiter: ocrAuthRateLimiter,
          auditWriter: async (event) => {
            await insertAuditLog(
              event.username,
              event.action,
              event.metadata === undefined ? undefined : JSON.stringify(event.metadata),
              { actorUserId: event.userId },
            );
          },
        });
        await adminScope.register(lineImageExtractionController, {
          prefix: "/line-image-extractions",
        });
        await adminScope.register(notificationReconciliationController, {
          prefix: "/notification-reconciliation",
          ...options.notificationReconciliation,
        });
      });
    },
    { prefix: "/api" },
  );

  // SPA catch-all: serve index.html with per-request nonce for non-API routes.
  app.get("/*", async (req, reply) => {
    if (
      req.url.startsWith("/api/") ||
      req.url.startsWith("/assets/") ||
      req.url.startsWith("/vite.svg") ||
      req.url.startsWith("/metrics") ||
      req.url.startsWith("/health") ||
      req.url.startsWith("/ready") ||
      req.url.startsWith("/events") ||
      req.url.startsWith("/line-images/")
    ) {
      return reply.callNotFound();
    }
    const nonce =
      (req as FastifyRequest & { cspNonce?: string }).cspNonce ??
      randomBytes(16).toString("base64");
    reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(renderSpaIndex(nonce));
  });

  const builtApp = app;
  app = previousApp;
  return builtApp;
}

export async function startHttpServer(
  port: number,
  options: HttpServerOptions = { surface: "web-api" },
): Promise<void> {
  app = await createHttpServer(options);

  await app.listen({ port, host: "0.0.0.0" });
  logger.info("http-server-started", { url: `http://localhost:${port}`, surface: options.surface, role: options.role });
}

export async function stopHttpServer(): Promise<void> {
  if (!app) return;
  await app.close();
  app = null;
  requestBuckets.clear();
  lastBucketCleanup = 0;
}
