import type { FastifyPluginAsync } from "fastify";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { insertAutoAcceptHistory } from "../repositories/auto-accept-repository.js";
import { getTeamRuntimeConfig, type TeamRuntimeConfig } from "../repositories/team-repository.js";
import { ApiClient } from "../services/api-client.js";
import { sendAutoAcceptSuccessNotification } from "../services/notifier.js";
import { requireRequestUser, resolveScopedTeamId } from "../services/team-scope.js";
import { extractAllRequestListTrips, type ExtractedTripInfo } from "../utils/booking-extractor.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { sendSuccess, sendError } from "../utils/response.js";

interface AcceptBody {
  teamId?: number;
  bookingId?: number;
  requestIds?: number[];
  confirm?: boolean;
}

interface AcceptAllBody {
  teamId?: number;
  bookingId?: number;
  confirm?: boolean;
}

const MANUAL_ACCEPT_ALL_RULE_ID = "manual-accept-all";
const MANUAL_ACCEPT_ALL_RULE_NAME = "Manual accept_all";

function uniquePositiveIntegers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value > 0))];
}

async function getEnabledTeamRuntimeConfig(teamId: number): Promise<TeamRuntimeConfig> {
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
  return team;
}

function apiClientForTeam(team: TeamRuntimeConfig): ApiClient {
  return new ApiClient({
    credentials: {
      spxCookie: team.spxCookie,
      spxDeviceId: team.spxDeviceId,
    },
  });
}

async function getApiClientForTeam(teamId: number): Promise<ApiClient> {
  return apiClientForTeam(await getEnabledTeamRuntimeConfig(teamId));
}

function acceptAllSuccessCount(response: { data?: unknown } | null): number {
  const data = response?.data;
  if (!data || typeof data !== "object") return 1;
  const successCount = (data as Record<string, unknown>).success_count;
  return typeof successCount === "number" && Number.isFinite(successCount) && successCount > 0
    ? Math.floor(successCount)
    : 1;
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isVerifiedAcceptedTrip(trip: ExtractedTripInfo): boolean {
  return Number.isInteger(trip.request_id)
    && trip.request_id > 0
    && trip.acceptance_status === 2;
}

async function fetchOwnedAcceptedTrips(
  apiClient: ApiClient,
  bookingId: number,
  context: { booking_id: number; booking_name: string; agency_name: string },
  excludeRequestIds = new Set<number>()
): Promise<ExtractedTripInfo[]> {
  const [pendingList, confirmedList] = await Promise.all([
    apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: true }),
    apiClient.fetchBookingRequestList(bookingId, { tabPendingConfirmation: false }),
  ]);
  if (!pendingList && !confirmedList) {
    throw new Error("SPX request-list tabs unavailable");
  }
  const byRequestId = new Map<number, ExtractedTripInfo>();

  for (const list of [pendingList, confirmedList]) {
    if (!list) continue;
    for (const trip of extractAllRequestListTrips(list.data, context)) {
      if (!isVerifiedAcceptedTrip(trip) || excludeRequestIds.has(trip.request_id)) continue;
      byRequestId.set(trip.request_id, trip);
    }
  }

  return [...byRequestId.values()];
}

function acceptedRequestIdSet(trips: ExtractedTripInfo[]): Set<number> {
  return new Set(trips.map((trip) => trip.request_id));
}

async function recordManualAcceptAllSuccess(
  team: TeamRuntimeConfig,
  bookingId: number,
  response: { data?: unknown } | null,
  acceptedTrips: ExtractedTripInfo[]
): Promise<boolean> {
  const acceptedCount = acceptedTrips.length > 0 ? acceptedTrips.length : acceptAllSuccessCount(response);
  await insertAutoAcceptHistory(team.id, {
    ruleId: MANUAL_ACCEPT_ALL_RULE_ID,
    ruleName: MANUAL_ACCEPT_ALL_RULE_NAME,
    bookingId,
    requestIds: acceptedTrips.map((trip) => trip.request_id),
    acceptedCount,
    origin: textValue(acceptedTrips[0]?.["ต้นทาง"]),
    destination: textValue(acceptedTrips[0]?.["ปลายทาง"]),
    vehicleType: textValue(acceptedTrips[0]?.["ประเภทรถ"]),
    status: "success",
  });

  if (acceptedTrips.length === 0) return false;
  return sendAutoAcceptSuccessNotification(
    acceptedTrips.map((trip) => ({ trip, bookingId, requestId: trip.request_id })),
    { teamId: team.id, teamName: team.name, lineGroupId: team.lineGroupId }
  );
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

const acceptAllSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bookingId", "confirm"],
  properties: {
    teamId: { type: "integer", minimum: 1 },
    bookingId: { type: "integer", minimum: 1 },
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

  app.post<{ Body: AcceptAllBody }>("/accept-all", { schema: { body: acceptAllSchema } }, async (req, reply) => {
    const actor = requireRequestUser(req);
    if (actor.role !== "admin") {
      return sendError(reply, 403, "FORBIDDEN", "Accept-all is restricted to admins");
    }

    const bookingId = req.body.bookingId;
    if (!Number.isInteger(bookingId) || bookingId === undefined || bookingId <= 0 || req.body.confirm !== true) {
      return sendError(reply, 400, "VALIDATION_ERROR", "bookingId and confirm=true are required");
    }
    if (!Number.isInteger(req.body.teamId) || req.body.teamId === undefined || req.body.teamId <= 0) {
      return sendError(reply, 400, "TEAM_REQUIRED", "Admin accept-all requests must include teamId");
    }

    const validBookingId: number = bookingId;
    const teamId = req.body.teamId;
    const team = await getEnabledTeamRuntimeConfig(teamId);
    const apiClient = apiClientForTeam(team);
    const bookingContext = { booking_id: validBookingId, booking_name: `booking_id=${validBookingId}`, agency_name: "" };
    let previouslyAcceptedRequestIds = new Set<number>();
    let beforeReconcileSucceeded = false;
    try {
      previouslyAcceptedRequestIds = acceptedRequestIdSet(await fetchOwnedAcceptedTrips(apiClient, validBookingId, bookingContext));
      beforeReconcileSucceeded = true;
    } catch (err) {
      logger.warn("manual-accept-all-before-reconcile-failed", {
        bookingId: validBookingId,
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const result = await apiClient.acceptAllBookingRequests(validBookingId);

    await insertAuditLog(
      actor.username,
      result.ok ? "Accept All Booking Requests" : "Accept All Booking Requests Failed",
      `booking_id=${bookingId}; accept_all=true; status=${result.httpStatus}; message=${result.response?.message ?? result.error ?? ""}`,
      { actorUserId: actor.id, actorTeamId: actor.teamId, targetTeamId: teamId },
    );

    if (!result.ok) {
      const statusCode = result.httpStatus >= 400 ? result.httpStatus : 502;
      return sendError(
        reply,
        statusCode,
        "ACCEPT_ALL_FAILED",
        result.error || result.response?.message || "Accept-all request failed",
        result.response
      );
    }

    let acceptedTrips: ExtractedTripInfo[] = [];
    if (beforeReconcileSucceeded) {
      try {
        acceptedTrips = await fetchOwnedAcceptedTrips(apiClient, validBookingId, bookingContext, previouslyAcceptedRequestIds);
      } catch (err) {
        logger.warn("manual-accept-all-after-reconcile-failed", {
          bookingId: validBookingId,
          teamId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn("manual-accept-all-reconcile-skipped", {
        bookingId: validBookingId,
        teamId,
        reason: "before snapshot failed",
      });
    }
    const notified = await recordManualAcceptAllSuccess(team, validBookingId, result.response, acceptedTrips);

    return sendSuccess(reply, {
      bookingId,
      teamId,
      acceptAll: true,
      acceptedCount: acceptedTrips.length > 0 ? acceptedTrips.length : acceptAllSuccessCount(result.response),
      requestIds: acceptedTrips.map((trip) => trip.request_id),
      notified,
      response: result.response,
    }, "Booking accept-all submitted successfully");
  });
};
