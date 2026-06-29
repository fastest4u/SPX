import type { FastifyPluginAsync } from "fastify";
import { getNotificationQueueSummary } from "../repositories/notification-repository.js";
import { listRuntimeNodes, listTeamRuntimeLeases } from "../repositories/runtime-repository.js";
import { sendSuccess } from "../utils/response.js";

export const runtimeStatusController: FastifyPluginAsync = async (app) => {
  app.get("/status", async (_request, reply) => {
    const [nodes, leases, notifications] = await Promise.all([
      listRuntimeNodes(),
      listTeamRuntimeLeases(),
      getNotificationQueueSummary(),
    ]);

    return sendSuccess(reply, { nodes, leases, notifications });
  });
};
