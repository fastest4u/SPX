import type { FastifyPluginAsync } from "fastify";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { ApiClient } from "../services/api-client.js";
import type { AuthUser } from "../services/authz.js";

interface AcceptBody {
  bookingId?: number;
  requestIds?: number[];
  confirm?: boolean;
}

function currentUser(req: { user?: unknown }): AuthUser {
  return req.user as AuthUser;
}

function uniquePositiveIntegers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value > 0))];
}

const acceptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bookingId", "requestIds", "confirm"],
  properties: {
    bookingId: { type: "integer", minimum: 1 },
    requestIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "integer", minimum: 1 } },
    confirm: { type: "boolean", const: true },
  },
} as const;

export const biddingController: FastifyPluginAsync = async (app) => {
  app.post<{ Body: AcceptBody }>("/accept", { schema: { body: acceptSchema } }, async (req, reply) => {
    const bookingId = req.body.bookingId;
    const requestIds = uniquePositiveIntegers(req.body.requestIds);

    if (!Number.isInteger(bookingId) || bookingId === undefined || bookingId <= 0 || requestIds.length === 0 || req.body.confirm !== true) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "bookingId, requestIds, and confirm=true are required" } });
    }

    const validBookingId: number = bookingId;
    const apiClient = new ApiClient();
    const result = await apiClient.acceptBookingRequests(validBookingId, requestIds);
    const actor = currentUser(req).username;

    await insertAuditLog(
      actor,
      result.ok ? "Accept Booking Request" : "Accept Booking Request Failed",
      `booking_id=${bookingId}; request_ids=${requestIds.join(",")}; status=${result.httpStatus}; message=${result.response?.message ?? result.error ?? ""}`,
    );

    if (!result.ok) {
      return reply.code(result.httpStatus >= 400 ? result.httpStatus : 502).send({
        error: {
          code: "ACCEPT_FAILED",
          message: result.error || result.response?.message || "Accept request failed",
          details: result.response,
        },
      });
    }

    return {
      ok: true,
      bookingId,
      requestIds,
      response: result.response,
    };
  });
};
