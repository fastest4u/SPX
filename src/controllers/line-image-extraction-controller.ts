import type { FastifyPluginAsync } from "fastify";
import {
  getLineImageExtractionsPaginated,
  type LineImageExtractionQuery,
} from "../repositories/line-image-extraction-repository.js";
import { sendPaginated } from "../utils/response.js";

const lineImageExtractionQuerySchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 200, default: 25 },
    search: { type: "string", maxLength: 200 },
    agency: { type: "string", maxLength: 100 },
    tripNumber: { type: "string", maxLength: 100 },
    route: { type: "string", maxLength: 255 },
    vehicleType: { type: "string", maxLength: 100 },
    driver: { type: "string", maxLength: 200 },
    createdFrom: { type: "string", maxLength: 50 },
    createdTo: { type: "string", maxLength: 50 },
    month: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    sortBy: { type: "string", enum: ["created_at", "date_text", "trip_number", "driver_name", "route"] },
    sortDir: { type: "string", enum: ["asc", "desc"] },
  },
} as const;

export const lineImageExtractionController: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    { schema: { querystring: lineImageExtractionQuerySchema } },
    async (req, reply) => {
      const query = req.query as LineImageExtractionQuery;
      const result = await getLineImageExtractionsPaginated({
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25,
        search: query.search,
        agency: query.agency,
        tripNumber: query.tripNumber,
        route: query.route,
        vehicleType: query.vehicleType,
        driver: query.driver,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        month: query.month,
        sortBy: query.sortBy ?? "created_at",
        sortDir: query.sortDir ?? "desc",
      });

      return sendPaginated(reply, result.data, result.page, result.pageSize, result.total);
    },
  );
};
