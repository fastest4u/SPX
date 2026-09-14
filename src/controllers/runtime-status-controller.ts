import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import { getNotificationQueueSummary } from "../repositories/notification-repository.js";
import { listRuntimeNodes, listTeamRuntimeLeases } from "../repositories/runtime-repository.js";
import { collectConfiguredDownstreamHealth } from "../services/service-health.js";
import { projectPublicRuntimeStatusReadModel } from "../services/runtime-status-read-model.js";
import type { RealtimeReadGateway } from "../services/realtime-service-client.js";
import { sendSuccess, sendError } from "../utils/response.js";

export interface RuntimeStatusControllerOptions {
  realtimeReadGateway?: RealtimeReadGateway;
  loadLocalRuntimeStatus?: () => Promise<unknown>;
}

async function defaultLocalRuntimeStatus(): Promise<unknown> {
  const [nodes, leases, notifications, serviceHealth] = await Promise.all([
    listRuntimeNodes(),
    listTeamRuntimeLeases(),
    getNotificationQueueSummary(),
    collectConfiguredDownstreamHealth({
      role: env.SPX_ROLE,
      nodeId: env.SPX_NODE_ID || "web-api",
      lineServiceUrl: env.LINE_SERVICE_URL,
      lineServiceRequestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
      ocrServiceUrl: env.OCR_SERVICE_URL,
      ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
    }),
  ]);
  return { nodes, leases, notifications, serviceHealth };
}

export const runtimeStatusController: FastifyPluginAsync<RuntimeStatusControllerOptions> = async (app, options) => {
  app.get("/status", async (_request, reply) => {
    if (options.realtimeReadGateway) {
      try {
        const remote = await options.realtimeReadGateway.readRuntimeStatus({ scope: { kind: "admin" } });
        // Project the remote payload through the reviewed public schema so
        // node metadata, lease internals, and debug fields stay on the
        // allowlist regardless of what the upstream included.
        return sendSuccess(reply, projectPublicRuntimeStatusReadModel(remote));
      } catch {
        return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
      }
    }

    try {
      return sendSuccess(reply, await (options.loadLocalRuntimeStatus ?? defaultLocalRuntimeStatus)());
    } catch {
      return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
    }
  });
};
