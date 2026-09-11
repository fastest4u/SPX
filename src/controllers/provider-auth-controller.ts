import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { getTeamProviderAuthStatus } from "../repositories/team-provider-auth-repository.js";
import type { ProviderAuthErrorCode, ProviderAuthRecord, ProviderAuthStatus, ProviderCredentials } from "../models/provider-auth.js";
import { ProviderAuthError } from "../services/provider-auth/client.js";
import { providerAuthService, type ProviderAuthService } from "../services/provider-auth/session-service.js";
import type { AuthUser } from "../services/authz.js";
import { requireTeamUser } from "../services/team-scope.js";
import { sendError, sendSuccess } from "../utils/response.js";

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 4096;

export interface ProviderAuthControllerDependencies {
  authService?: ProviderAuthService;
  getStatus?: (teamId: number) => Promise<ProviderAuthStatus | null>;
  audit?: (input: { actor: AuthUser; operation: "connect" | "reconnect"; teamId: number }) => Promise<void>;
}

interface ProviderAuthBody {
  email: string;
  password: string;
}

interface TeamParams {
  id: string;
}

const connectBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 1, maxLength: MAX_EMAIL_LENGTH },
    password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

function publicStatus(status: ProviderAuthStatus | ProviderAuthRecord): ProviderAuthStatus {
  return {
    teamId: status.teamId,
    email: status.email,
    hasPassword: status.hasPassword,
    status: status.status,
    lastLoginAt: status.lastLoginAt,
    expiresAt: status.expiresAt,
    errorCode: status.errorCode,
    retryAt: status.retryAt,
  };
}

function hasOnlyKeys(body: unknown, allowed: readonly string[]): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body))
    && Object.keys(body as Record<string, unknown>).every((key) => allowed.includes(key));
}

function rejectUnknownBodyKeys(allowed: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.body === undefined && allowed.length === 0) return;
    if (!hasOnlyKeys(request.body, allowed)) {
      sendError(reply, 400, "VALIDATION_ERROR", "Request body contains unsupported fields");
    }
  };
}

function requestUser(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  const user = request.user as AuthUser | undefined;
  if (!user) {
    sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    return null;
  }
  return user;
}

function ownTeamId(request: FastifyRequest, reply: FastifyReply): { user: AuthUser; teamId: number } | null {
  const user = requestUser(request, reply);
  if (!user) return null;
  if (user.role !== "user") {
    sendError(reply, 403, "FORBIDDEN", "Team user access is required");
    return null;
  }
  let teamId: number;
  try {
    teamId = requireTeamUser(request);
  } catch {
    sendError(reply, 400, "TEAM_REQUIRED", "Team scope is required");
    return null;
  }
  return { user, teamId };
}

function adminTeamId(request: FastifyRequest, reply: FastifyReply): { user: AuthUser; teamId: number } | null {
  const user = requestUser(request, reply);
  if (!user) return null;
  if (user.role !== "admin") {
    sendError(reply, 403, "FORBIDDEN", "Admin access is required");
    return null;
  }
  const rawId = (request.params as TeamParams).id;
  if (!/^[1-9]\d*$/.test(rawId)) {
    sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    return null;
  }
  const teamId = Number(rawId);
  if (!Number.isSafeInteger(teamId)) {
    sendError(reply, 400, "VALIDATION_ERROR", "Invalid team id");
    return null;
  }
  return { user, teamId };
}

function errorResponse(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof ProviderAuthError)) {
    sendError(reply, 502, "PROVIDER_AUTH_UNAVAILABLE", "Provider authentication is unavailable");
    return;
  }

  const code = error.code as ProviderAuthErrorCode;
  if (code === "busy") {
    sendError(reply, 409, "PROVIDER_AUTH_BUSY", "Provider authentication is already in progress");
    return;
  }
  if (code === "rate_limited") {
    const retryAfterMs = Math.max(0, error.retryAfterMs ?? 0);
    reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    sendError(reply, 429, "PROVIDER_AUTH_RATE_LIMITED", "Provider authentication is temporarily unavailable", { retryAfterMs });
    return;
  }
  if (code === "provider_unavailable" || code === "invalid_response") {
    sendError(reply, 502, "PROVIDER_AUTH_UNAVAILABLE", "Provider authentication is unavailable");
    return;
  }
  if (code === "not_configured") {
    sendError(reply, 400, "PROVIDER_AUTH_NOT_CONFIGURED", "Provider account is not configured");
    return;
  }
  sendError(reply, 400, "PROVIDER_AUTH_FAILED", "Provider authentication was not accepted");
}

type TeamScope = { user: AuthUser; teamId: number };
type TeamScopeResolver = (request: FastifyRequest, reply: FastifyReply) => TeamScope | null;

function controllerDependencies(dependencies: ProviderAuthControllerDependencies) {
  const authService = dependencies.authService ?? providerAuthService;
  const getStatus = dependencies.getStatus ?? getTeamProviderAuthStatus;
  const audit = dependencies.audit ?? (async ({ actor, operation, teamId }) => {
    await insertAuditLog(
      actor.username,
      operation === "connect" ? "Connect Provider Account" : "Reconnect Provider Account",
      `${operation === "connect" ? "Connected" : "Reconnected"} provider account for team ${teamId}`,
      { actorUserId: actor.id, actorTeamId: actor.teamId, targetTeamId: teamId },
    );
  });
  return { authService, getStatus, audit };
}

function createProviderAuthHandlers(
  dependencies: ReturnType<typeof controllerDependencies>,
  resolveScope: TeamScopeResolver,
) {
  async function status(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const scope = resolveScope(request, reply);
    if (!scope) return;
    const result = await dependencies.getStatus(scope.teamId);
    if (!result) return sendError(reply, 404, "NOT_FOUND", "Team not found");
    sendSuccess(reply, publicStatus(result));
  }

  async function connect(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const scope = resolveScope(request, reply);
    if (!scope) return;
    try {
      const result = await dependencies.authService.connect(scope.teamId, request.body as ProviderCredentials);
      if (!result) return sendError(reply, 404, "NOT_FOUND", "Team not found");
      await dependencies.audit({ actor: scope.user, operation: "connect", teamId: scope.teamId });
      sendSuccess(reply, publicStatus(result), "Provider account connected");
    } catch (error) {
      errorResponse(reply, error);
    }
  }

  async function reconnect(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const scope = resolveScope(request, reply);
    if (!scope) return;
    try {
      const result = await dependencies.authService.reconnect(scope.teamId);
      if (!result) return sendError(reply, 404, "NOT_FOUND", "Team not found");
      await dependencies.audit({ actor: scope.user, operation: "reconnect", teamId: scope.teamId });
      sendSuccess(reply, publicStatus(result), "Provider account reconnected");
    } catch (error) {
      errorResponse(reply, error);
    }
  }

  return { status, connect, reconnect };
}

export function createOwnTeamProviderAuthController(
  dependencies: ProviderAuthControllerDependencies = {},
): FastifyPluginAsync {
  const handlers = createProviderAuthHandlers(controllerDependencies(dependencies), ownTeamId);
  return async (app) => {
    app.get("/", handlers.status);

    app.put<{ Body: ProviderAuthBody }>("/", {
      schema: { body: connectBodySchema },
      preValidation: rejectUnknownBodyKeys(["email", "password"]),
    }, handlers.connect);

    app.post("/reconnect", {
      preValidation: rejectUnknownBodyKeys([]),
    }, handlers.reconnect);
  };
}

export function createAdminProviderAuthController(
  dependencies: ProviderAuthControllerDependencies = {},
): FastifyPluginAsync {
  const handlers = createProviderAuthHandlers(controllerDependencies(dependencies), adminTeamId);
  return async (app) => {
    app.get<{ Params: TeamParams }>("/:id/provider-auth", handlers.status);

    app.put<{ Params: TeamParams; Body: ProviderAuthBody }>("/:id/provider-auth", {
      schema: { body: connectBodySchema },
      preValidation: rejectUnknownBodyKeys(["email", "password"]),
    }, handlers.connect);

    app.post<{ Params: TeamParams }>("/:id/provider-auth/reconnect", {
      preValidation: rejectUnknownBodyKeys([]),
    }, handlers.reconnect);
  };
}
