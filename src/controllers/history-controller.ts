import type { FastifyPluginAsync } from "fastify";
import { getBookingHistory } from "../repositories/booking-history-repository.js";

export const historyController: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
            search: { type: "string", maxLength: 200 },
            bookingId: { type: "integer", minimum: 1 },
            origin: { type: "string", maxLength: 255 },
            destination: { type: "string", maxLength: 255 },
            vehicleType: { type: "string", maxLength: 50 },
            sortBy: { type: "string", enum: ["created_at", "request_id"] },
            sortDir: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
    },
    async (req) => {
      const query = req.query as {
        limit?: number;
        search?: string;
        bookingId?: number;
        origin?: string;
        destination?: string;
        vehicleType?: string;
        sortBy?: "created_at" | "request_id";
        sortDir?: "asc" | "desc";
      };
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
};
