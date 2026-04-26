import type { FastifyPluginAsync } from "fastify";
import { getAuditLogs } from "../repositories/audit-repository.js";
import { sendSuccess } from "../utils/response.js";

export const auditController: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
            search: { type: "string", maxLength: 200 },
            username: { type: "string", maxLength: 50 },
            action: { type: "string", maxLength: 100 },
            sortBy: { type: "string", enum: ["created_at", "id"] },
            sortDir: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.query as {
        limit?: number;
        search?: string;
        username?: string;
        action?: string;
        sortBy?: "created_at" | "id";
        sortDir?: "asc" | "desc";
      };
      const logs = await getAuditLogs({
        limit: query.limit ?? 200,
        search: query.search,
        username: query.username,
        action: query.action,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
      return sendSuccess(reply, logs);
    }
  );
};
