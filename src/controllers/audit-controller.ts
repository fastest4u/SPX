import type { FastifyPluginAsync } from "fastify";
import { getAuditLogs, getAuditLogsPaginated } from "../repositories/audit-repository.js";
import { sendSuccess, sendPaginated } from "../utils/response.js";

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

  app.get(
    "/paginated",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 25 },
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
        page?: number;
        pageSize?: number;
        search?: string;
        username?: string;
        action?: string;
        sortBy?: "created_at" | "id";
        sortDir?: "asc" | "desc";
      };
      const result = await getAuditLogsPaginated({
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25,
        search: query.search,
        username: query.username,
        action: query.action,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
      return sendPaginated(reply, result.data, result.page, result.pageSize, result.total);
    }
  );
};
