import type { FastifyPluginAsync } from "fastify";
import { getAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import { sendSuccess } from "../utils/response.js";

export const autoAcceptHistoryController: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
            search: { type: "string", maxLength: 200 },
            ruleName: { type: "string", maxLength: 128 },
            status: { type: "string", enum: ["success", "failed"] },
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
        ruleName?: string;
        status?: string;
        sortBy?: "created_at" | "id";
        sortDir?: "asc" | "desc";
      };
      const rows = await getAutoAcceptHistory({
        limit: query.limit ?? 200,
        search: query.search,
        ruleName: query.ruleName,
        status: query.status,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
      return sendSuccess(reply, rows);
    }
  );
};
