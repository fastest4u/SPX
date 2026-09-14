import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getRecentMetricsSnapshots } from "../repositories/metrics-repository.js";
import { listMergedRealtimeMetricsReadModels } from "../repositories/realtime-execution-metrics-repository.js";
import { getRealtimeReplayHighWater } from "../repositories/realtime-event-repository.js";
import { listTeams } from "../repositories/team-repository.js";
import {
  InternalRequestReplayGuard,
  type InternalRequestReplayStore,
  type NodeSecretKeyRing,
  verifyInternalNodeSignature,
  verifyInternalSignature,
} from "../services/internal-auth.js";
import { metrics } from "../services/metrics.js";
import {
  replayRealtimeEventsAfterRowIdUntilCaughtUp,
  replayRealtimeEventsFromCursor,
} from "../services/realtime-replay.js";
import type { RealtimeScope } from "../services/realtime-contract.js";
import {
  runtimeMetricsSummaryReadModelFromRecords,
  runtimeMetricsSnapshotFor,
  type RuntimeMetricsRecord,
} from "../services/runtime-metrics.js";
import { sseBroadcaster, type SseBroadcaster } from "../services/sse.js";
import { sendError, sendSuccess } from "../utils/response.js";

interface InternalRealtimeReadBody {
  scope: RealtimeScope;
  limit?: number;
  lastEventId?: string;
}

type MetricsHistoryRow = Awaited<ReturnType<typeof getRecentMetricsSnapshots>>[number];

export interface InternalRealtimeReadControllerOptions {
  sharedSecret?: string;
  resolveSecretForNode?: (nodeId: string) => NodeSecretKeyRing | string | undefined;
  trustedNodeIds: Set<string>;
  adminNodeIds: Set<string>;
  allowedNodeTeams: Map<string, Set<number>>;
  listMetricsRecords?: () => Promise<RuntimeMetricsRecord[]>;
  listExpectedTeamIds?: () => Promise<number[]>;
  listMetricsHistory?: (input: { limit: number; teamId?: number }) => Promise<MetricsHistoryRow[] | unknown[]>;
  loadRuntimeStatus: (scope: RealtimeScope) => Promise<unknown>;
  preflightReplayStore?: (scope: RealtimeScope) => Promise<unknown>;
  broadcaster?: Pick<SseBroadcaster, "addClient">;
  now?: () => Date;
  replayGuard?: InternalRequestReplayStore;
}

const paths = {
  metrics: "/internal/realtime/read-models/metrics",
  metricsHistory: "/internal/realtime/read-models/metrics-history",
  runtimeStatus: "/internal/realtime/read-models/runtime-status",
  stream: "/internal/realtime/stream",
} as const;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(rawBody: string): InternalRealtimeReadBody {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.scope)) {
    throw new Error("scope is required");
  }

  let scope: RealtimeScope;
  if (parsed.scope.kind === "admin") {
    scope = { kind: "admin" };
  } else if (
    parsed.scope.kind === "team" &&
    Number.isInteger(parsed.scope.teamId) &&
    (parsed.scope.teamId as number) > 0
  ) {
    scope = { kind: "team", teamId: parsed.scope.teamId as number };
  } else {
    throw new Error("scope is invalid");
  }

  if (
    parsed.limit !== undefined &&
    (!Number.isInteger(parsed.limit) || (parsed.limit as number) < 1 || (parsed.limit as number) > 500)
  ) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  if (
    parsed.lastEventId !== undefined &&
    (typeof parsed.lastEventId !== "string" || parsed.lastEventId.length > 255)
  ) {
    throw new Error("lastEventId must be a string");
  }

  return {
    scope,
    ...(parsed.limit !== undefined ? { limit: parsed.limit as number } : {}),
    ...(typeof parsed.lastEventId === "string" && parsed.lastEventId.trim().length > 0
      ? { lastEventId: parsed.lastEventId.trim() }
      : {}),
  };
}

function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  rawBody: string,
  options: InternalRealtimeReadControllerOptions,
  onPreviousKeyUsed: (nodeId: string) => void,
): { nodeId: string; requestId: string; timestamp: string } | null {
  const nodeId = firstHeader(request.headers["x-spx-node-id"]);
  const timestamp = firstHeader(request.headers["x-spx-timestamp"]);
  const signature = firstHeader(request.headers["x-spx-signature"]);
  const requestId = firstHeader(request.headers["x-spx-request-id"]);
  if (!nodeId || !timestamp || !signature || !requestId) {
    sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", { retryable: false });
    return null;
  }

  let nodeSecret: NodeSecretKeyRing | string | undefined;
  try {
    nodeSecret = options.resolveSecretForNode?.(nodeId);
  } catch {
    sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", { retryable: false });
    return null;
  }
  let authenticated = false;
  if (options.resolveSecretForNode) {
    if (nodeSecret !== undefined) {
      const ring = typeof nodeSecret === "string" ? { active: nodeSecret } : nodeSecret;
      authenticated = verifyInternalNodeSignature({
        body: rawBody,
        timestamp,
        nodeId,
        path,
        nodeSecrets: new Map([[nodeId, ring]]),
        signature,
        requestId,
        onKeyGeneration: (generation) => {
          if (generation === "previous") onPreviousKeyUsed(nodeId);
        },
      }).ok;
    }
  } else {
    const secret = options.sharedSecret;
    authenticated = typeof secret === "string" && secret.trim().length > 0
      && verifyInternalSignature({
        body: rawBody,
        timestamp,
        nodeId,
        path,
        secret,
        signature,
        requestId,
      }).ok;
  }
  if (!authenticated) {
    sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", { retryable: false });
    return null;
  }
  if (!options.trustedNodeIds.has(nodeId)) {
    sendError(reply, 403, "INTERNAL_REALTIME_READ_FORBIDDEN", "Node is not trusted for realtime reads", { retryable: false });
    return null;
  }
  return { nodeId, requestId, timestamp };
}

function enforceScope(
  nodeId: string,
  scope: RealtimeScope,
  options: InternalRealtimeReadControllerOptions,
  reply: FastifyReply,
): boolean {
  if (options.adminNodeIds.has(nodeId)) return true;
  if (scope.kind === "team" && options.allowedNodeTeams.get(nodeId)?.has(scope.teamId)) return true;
  sendError(reply, 403, "INTERNAL_REALTIME_READ_FORBIDDEN", "Node is not allowed to read this scope", { retryable: false });
  return false;
}

async function parseAuthorizedBody(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  options: InternalRealtimeReadControllerOptions,
  replayGuard: InternalRequestReplayStore,
  onPreviousKeyUsed: (nodeId: string) => void,
): Promise<{ body: InternalRealtimeReadBody; nodeId: string } | null> {
  const rawBody = typeof request.body === "string" ? request.body : "";
  const authentication = authenticate(request, reply, path, rawBody, options, onPreviousKeyUsed);
  if (!authentication) return null;

  let body: InternalRealtimeReadBody;
  try {
    body = parseBody(rawBody);
  } catch {
    sendError(reply, 400, "INTERNAL_REALTIME_READ_INVALID", "Invalid realtime read request", { retryable: false });
    return null;
  }
  if (!enforceScope(authentication.nodeId, body.scope, options, reply)) return null;
  const replay = await replayGuard.consume({
    nodeId: authentication.nodeId,
    requestId: authentication.requestId,
    signedTimestamp: authentication.timestamp,
    partition: "realtime-read",
  });
  if (!replay.ok) {
    if (replay.reason === "capacity") {
      sendError(reply, 429, "INTERNAL_REPLAY_CAPACITY", "Internal request capacity exceeded", {
        retryable: true,
      });
    } else if (replay.reason === "replay") {
      sendError(reply, 409, "INTERNAL_REQUEST_REPLAYED", "Internal request was already processed", {
        retryable: false,
      });
    } else {
      sendError(reply, 401, "INTERNAL_AUTH_FAILED", "Internal authentication failed", {
        retryable: false,
      });
    }
    return null;
  }
  return { body, nodeId: authentication.nodeId };
}

function sendReadUnavailable(reply: FastifyReply): void {
  sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
}

export const internalRealtimeReadController: FastifyPluginAsync<InternalRealtimeReadControllerOptions> = async (
  app,
  options,
) => {
  const listMetricsRecords = options.listMetricsRecords ?? (() => listMergedRealtimeMetricsReadModels((options.now?.() ?? new Date()).getTime()));
  const listExpectedTeamIds = options.listExpectedTeamIds ?? (async () => (await listTeams()).map((team) => team.id));
  const listMetricsHistory = options.listMetricsHistory ?? (async ({ limit, teamId }) => (
    getRecentMetricsSnapshots(limit, teamId)
  ));
  const preflightReplayStore = options.preflightReplayStore ?? getRealtimeReplayHighWater;
  const broadcaster = options.broadcaster ?? sseBroadcaster;
  const replayGuard = options.replayGuard ?? new InternalRequestReplayGuard();
  const onPreviousKeyUsed = (nodeId: string) => {
    app.log.warn({ nodeId, boundary: "realtime-read" }, "internal-hmac-previous-key-used");
  };

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/read-models/metrics", async (request, reply) => {
    const authorized = await parseAuthorizedBody(request, reply, paths.metrics, options, replayGuard, onPreviousKeyUsed);
    if (!authorized) return;
    try {
      const [records, expectedTeamIds] = await Promise.all([
        listMetricsRecords(),
        authorized.body.scope.kind === "admin" ? listExpectedTeamIds() : Promise.resolve([]),
      ]);
      const teamId = authorized.body.scope.kind === "team" ? authorized.body.scope.teamId : null;
      const readModel = runtimeMetricsSummaryReadModelFromRecords(
        runtimeMetricsSnapshotFor(metrics.snapshot(typeof teamId === "number" ? { teamId } : {}), teamId),
        records,
        teamId,
        {
          expectedTeamIds,
          now: (options.now?.() ?? new Date()).getTime(),
        },
      );
      return sendSuccess(reply, readModel);
    } catch {
      return sendReadUnavailable(reply);
    }
  });

  app.post("/read-models/metrics-history", async (request, reply) => {
    const authorized = await parseAuthorizedBody(request, reply, paths.metricsHistory, options, replayGuard, onPreviousKeyUsed);
    if (!authorized) return;
    try {
      const teamId = authorized.body.scope.kind === "team" ? authorized.body.scope.teamId : undefined;
      const history = await listMetricsHistory({ limit: authorized.body.limit ?? 100, teamId });
      return sendSuccess(reply, history);
    } catch {
      return sendReadUnavailable(reply);
    }
  });

  app.post("/read-models/runtime-status", async (request, reply) => {
    const authorized = await parseAuthorizedBody(request, reply, paths.runtimeStatus, options, replayGuard, onPreviousKeyUsed);
    if (!authorized) return;
    if (authorized.body.scope.kind !== "admin" || !options.adminNodeIds.has(authorized.nodeId)) {
      return sendError(
        reply,
        403,
        "INTERNAL_REALTIME_READ_FORBIDDEN",
        "Runtime status requires admin scope",
        { retryable: false },
      );
    }
    try {
      return sendSuccess(reply, await options.loadRuntimeStatus(authorized.body.scope));
    } catch {
      return sendReadUnavailable(reply);
    }
  });

  app.post("/stream", async (request, reply) => {
    const authorized = await parseAuthorizedBody(request, reply, paths.stream, options, replayGuard, onPreviousKeyUsed);
    if (!authorized) return;
    const scope = authorized.body.scope;
    const teamId = scope.kind === "team" ? scope.teamId : null;
    reply.hijack();
    await broadcaster.addClient(reply.raw, { teamId }, {
      resyncSource: { service: "realtime-service", nodeId: "realtime-service", role: "realtime-service" },
      preflight: async () => {
        await preflightReplayStore(scope);
      },
      replay: async (write) => replayRealtimeEventsFromCursor({
        scope,
        lastEventId: authorized.body.lastEventId,
        source: { service: "realtime-service", nodeId: "realtime-service", role: "realtime-service" },
        write,
      }),
      afterReplay: async (write, replayResult, context) => {
        const cursor = replayResult as { lastRowId?: unknown } | null | undefined;
        if (typeof cursor?.lastRowId !== "number") return undefined;
        return replayRealtimeEventsAfterRowIdUntilCaughtUp({
          scope,
          afterRowId: cursor.lastRowId,
          deliveredEventIds: context.deliveredEventIds,
          write,
        });
      },
    });
  });
};
