import type { FastifyPluginAsync } from "fastify";
import { getBookingHistory, getBookingHistoryPaginated } from "../repositories/booking-history-repository.js";
import type { HistoryFilterQuery } from "../repositories/booking-history-repository.js";

const filterSchemaProps = {
  search: { type: "string", maxLength: 200 },
  bookingId: { type: "integer", minimum: 1 },
  origin: { type: "string", maxLength: 255 },
  destination: { type: "string", maxLength: 255 },
  vehicleType: { type: "string", maxLength: 50 },
  sortBy: { type: "string", enum: ["created_at", "request_id"] },
  sortDir: { type: "string", enum: ["asc", "desc"] },
} as const;

type HistoryListQuery = HistoryFilterQuery & { limit?: number };

export const historyController: FastifyPluginAsync = async (app) => {
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
    async (req) => {
      const query = req.query as HistoryListQuery;
      return await getBookingHistory({
        limit: query.limit ?? 200,
        search: query.search,
        bookingId: query.bookingId,
        origin: query.origin,
        destination: query.destination,
        vehicleType: query.vehicleType,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
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
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            ...filterSchemaProps,
          },
        },
      },
    },
    async (req) => {
      const query = req.query as HistoryFilterQuery & { page?: number; pageSize?: number };
      return await getBookingHistoryPaginated({
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 50,
        search: query.search,
        bookingId: query.bookingId,
        origin: query.origin,
        destination: query.destination,
        vehicleType: query.vehicleType,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });
    }
  );
};
