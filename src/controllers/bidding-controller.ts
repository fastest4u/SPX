import type { FastifyPluginAsync } from "fastify";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { getTeamRuntimeConfig } from "../repositories/team-repository.js";
import { ApiClient } from "../services/api-client.js";
import { requireRequestUser, resolveScopedTeamId } from "../services/team-scope.js";
import { AppError } from "../utils/errors.js";
import { sendSuccess, sendError } from "../utils/response.js";

interface AcceptBody {
  teamId?: number;
  bookingId?: number;
  requestIds?: number[];
  confirm?: boolean;
}

function uniquePositiveIntegers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value > 0))];
}

async function getApiClientForTeam(teamId: number): Promise<ApiClient> {
  const team = await getTeamRuntimeConfig(teamId);
  if (!team) {
    throw new AppError("Team not found", 404, "TEAM_NOT_FOUND");
  }
  if (!team.enabled) {
    throw new AppError("Team is disabled", 400, "TEAM_DISABLED");
  }
  if (!team.spxCookie || !team.spxDeviceId) {
    throw new AppError("Team SPX credentials are incomplete", 400, "TEAM_CREDENTIALS_REQUIRED");
  }
  return new ApiClient({
    credentials: {
      spxCookie: team.spxCookie,
      spxDeviceId: team.spxDeviceId,
    },
  });
}

const acceptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bookingId", "requestIds", "confirm"],
  properties: {
    teamId: { type: "integer", minimum: 1 },
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
      return sendError(reply, 400, "VALIDATION_ERROR", "bookingId, requestIds, and confirm=true are required");
    }

    const validBookingId: number = bookingId;
    const actor = requireRequestUser(req);
    const teamId = resolveScopedTeamId(req, req.body.teamId);
    const apiClient = await getApiClientForTeam(teamId);
    const result = await apiClient.acceptBookingRequests(validBookingId, requestIds);

    await insertAuditLog(
      actor.username,
      result.ok ? "Accept Booking Request" : "Accept Booking Request Failed",
      `booking_id=${bookingId}; request_ids=${requestIds.join(",")}; status=${result.httpStatus}; message=${result.response?.message ?? result.error ?? ""}`,
      { actorUserId: actor.id, actorTeamId: actor.teamId, targetTeamId: teamId },
    );

    if (!result.ok) {
      const statusCode = result.httpStatus >= 400 ? result.httpStatus : 502;
      return sendError(
        reply,
        statusCode,
        "ACCEPT_FAILED",
        result.error || result.response?.message || "Accept request failed",
        result.response
      );
    }

    return sendSuccess(reply, {
      bookingId,
      requestIds,
      response: result.response,
    }, "Booking accepted successfully");
  });
};
