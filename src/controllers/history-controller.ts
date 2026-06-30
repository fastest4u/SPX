import type { FastifyPluginAsync } from "fastify";
import { getBookingHistoryFilterOptionsForScope, getBookingHistoryForScope, getBookingHistoryPaginatedForScope } from "../repositories/booking-history-repository.js";
import type { HistoryFilterQuery } from "../repositories/booking-history-repository.js";
import { resolveScopedTeamId } from "../services/team-scope.js";
import type { AuthUser } from "../services/authz.js";
import { sendSuccess, sendPaginated } from "../utils/response.js";

const filterSchemaProps = {
  search: { type: "string", maxLength: 200 },
  requestId: { type: "integer", minimum: 1 },
  bookingId: { type: "integer", minimum: 1 },
  origin: { type: "string", maxLength: 255 },
  destination: { type: "string", maxLength: 255 },
  vehicleType: { type: "string", maxLength: 50 },
  sortBy: { type: "string", enum: ["created_at", "request_id"] },
  sortDir: { type: "string", enum: ["asc", "desc"] },
  teamId: { type: "integer", minimum: 1 },
} as const;

type HistoryListQuery = HistoryFilterQuery & { limit?: number; teamId?: number };

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function historyTeamScope(req: { user?: unknown }, explicitTeamId?: number): number | null {
  const user = currentUser(req);
  if (user.role === "admin" && typeof explicitTeamId !== "number") return null;
  return resolveScopedTeamId(req, explicitTeamId);
}

export const historyController: FastifyPluginAsync = async (app) => {
  app.get(
    "/filter-options",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            teamId: filterSchemaProps.teamId,
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.query as { teamId?: number };
      const teamId = historyTeamScope(req, query.teamId);
      const options = await getBookingHistoryFilterOptionsForScope(teamId);
      return sendSuccess(reply, options);
    }
  );

  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
            ...filterSchemaProps,
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.query as HistoryListQuery;
      const teamId = historyTeamScope(req, query.teamId);
      const rows = await getBookingHistoryForScope(teamId, {
        limit: query.limit ?? 200,
        search: query.search,
        requestId: query.requestId,
        bookingId: query.bookingId,
        origin: query.origin,
        destination: query.destination,
        vehicleType: query.vehicleType,
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
            ...filterSchemaProps,
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.query as HistoryFilterQuery & { page?: number; pageSize?: number; teamId?: number };
      const teamId = historyTeamScope(req, query.teamId);
      const result = await getBookingHistoryPaginatedForScope(teamId, {
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25,
        search: query.search,
        requestId: query.requestId,
        bookingId: query.bookingId,
        origin: query.origin,
        destination: query.destination,
        vehicleType: query.vehicleType,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
      return sendPaginated(reply, result.data, result.page, result.pageSize, result.total);
    }
  );
};
