import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import { getNotificationQueueSummary } from "../repositories/notification-repository.js";
import { listRuntimeNodes, listTeamRuntimeLeases } from "../repositories/runtime-repository.js";
import { collectConfiguredDownstreamHealth } from "../services/service-health.js";
import { sendSuccess } from "../utils/response.js";

export const runtimeStatusController: FastifyPluginAsync = async (app) => {
  app.get("/status", async (_request, reply) => {
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

    return sendSuccess(reply, { nodes, leases, notifications, serviceHealth });
  });
};
