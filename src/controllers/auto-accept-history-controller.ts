import type { FastifyPluginAsync } from "fastify";
import { getAutoAcceptHistoryForScope, getAutoAcceptHistoryPaginatedForScope } from "../repositories/auto-accept-repository.js";
import { resolveScopedTeamId } from "../services/team-scope.js";
import type { AuthUser } from "../services/authz.js";
import { sendSuccess, sendPaginated } from "../utils/response.js";

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function autoAcceptTeamScope(req: { user?: unknown }, explicitTeamId?: number): number | null {
  const user = currentUser(req);
  if (user.role === "admin" && typeof explicitTeamId !== "number") return null;
  return resolveScopedTeamId(req, explicitTeamId);
}

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
            teamId: { type: "integer", minimum: 1 },
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
        teamId?: number;
      };
      const teamId = autoAcceptTeamScope(req, query.teamId);
      const rows = await getAutoAcceptHistoryForScope(teamId, {
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
            ruleName: { type: "string", maxLength: 128 },
            status: { type: "string", enum: ["success", "failed"] },
            sortBy: { type: "string", enum: ["created_at", "id"] },
            sortDir: { type: "string", enum: ["asc", "desc"] },
            teamId: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.query as {
        page?: number;
        pageSize?: number;
        search?: string;
        ruleName?: string;
        status?: string;
        sortBy?: "created_at" | "id";
        sortDir?: "asc" | "desc";
        teamId?: number;
      };
      const teamId = autoAcceptTeamScope(req, query.teamId);
      const result = await getAutoAcceptHistoryPaginatedForScope(teamId, {
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25,
        search: query.search,
        ruleName: query.ruleName,
        status: query.status,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
      return sendPaginated(reply, result.data, result.page, result.pageSize, result.total);
    }
  );
};
