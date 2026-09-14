import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  reconcileNotificationProviderDelivery,
  listNotificationProviderReconciliationCandidates,
  type NotificationProviderReconciliationCandidate,
  type NotificationProviderReconciliationInput,
  type NotificationProviderReconciliationResult,
} from "../repositories/notification-repository.js";
import type { AuthUser } from "../services/authz.js";
import { sendError, sendSuccess } from "../utils/response.js";

type Reconcile = (
  input: NotificationProviderReconciliationInput,
) => Promise<NotificationProviderReconciliationResult>;

export interface NotificationReconciliationControllerOptions {
  reconcile?: Reconcile;
  listCandidates?: () => Promise<NotificationProviderReconciliationCandidate[]>;
}

interface ReconciliationParams {
  outboxId: string;
}

const EXPECTED_CONFIRMATIONS = {
  mark_sent: "PROVIDER_CONFIRMED_SENT",
  requeue_not_sent: "PROVIDER_CONFIRMED_NOT_SENT",
} as const;
const SAFE_EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/# -]{7,254}$/;
const DATABASE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredSafeString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function parseReconciliationBody(value: unknown): Omit<
  NotificationProviderReconciliationInput,
  "outboxId" | "actor"
> {
  if (!isObject(value)) throw new Error("body is invalid");
  const action = value.action;
  if (action !== "mark_sent" && action !== "requeue_not_sent") {
    throw new Error("action is invalid");
  }
  const expectedStatus = value.expectedStatus;
  if (expectedStatus !== "provider_sending" && expectedStatus !== "delivery_ambiguous") {
    throw new Error("expectedStatus is invalid");
  }
  if (value.confirmation !== EXPECTED_CONFIRMATIONS[action]) {
    throw new Error("confirmation is invalid");
  }
  const providerRequestId = requiredSafeString(value.providerRequestId, "providerRequestId", 1, 128);
  const expectedProviderStartedAt = requiredSafeString(
    value.expectedProviderStartedAt,
    "expectedProviderStartedAt",
    19,
    19,
  );
  if (!DATABASE_TIMESTAMP.test(expectedProviderStartedAt)) {
    throw new Error("expectedProviderStartedAt is invalid");
  }
  const evidenceReference = requiredSafeString(
    value.evidenceReference,
    "evidenceReference",
    8,
    255,
  );
  if (!SAFE_EVIDENCE_REFERENCE.test(evidenceReference)) {
    throw new Error("evidenceReference is invalid");
  }
  const reason = requiredSafeString(value.reason, "reason", 8, 500);
  let providerMessageId: string | undefined;
  if (value.providerMessageId !== undefined) {
    providerMessageId = requiredSafeString(value.providerMessageId, "providerMessageId", 1, 255);
  }
  return {
    action,
    expectedStatus,
    providerRequestId,
    expectedProviderStartedAt,
    evidenceReference,
    reason,
    ...(providerMessageId === undefined ? {} : { providerMessageId }),
  };
}

function currentAdmin(request: FastifyRequest): AuthUser | null {
  const user = (request as FastifyRequest & { user?: AuthUser }).user;
  return user?.role === "admin" ? user : null;
}

export const notificationReconciliationController: FastifyPluginAsync<
  NotificationReconciliationControllerOptions
> = async (app, options) => {
  const reconcile = options.reconcile ?? reconcileNotificationProviderDelivery;
  const listCandidates = options.listCandidates ?? listNotificationProviderReconciliationCandidates;

  app.get("/", async (request, reply) => {
    if (!currentAdmin(request)) {
      return sendError(reply, 403, "ADMIN_REQUIRED", "Admin access required");
    }
    try {
      return sendSuccess(reply, await listCandidates());
    } catch {
      return sendError(
        reply,
        503,
        "NOTIFICATION_RECONCILIATION_UNAVAILABLE",
        "Notification reconciliation is unavailable",
      );
    }
  });

  app.post<{ Params: ReconciliationParams }>("/:outboxId", async (request, reply) => {
    const actor = currentAdmin(request);
    if (!actor) {
      return sendError(reply, 403, "ADMIN_REQUIRED", "Admin access required");
    }
    const outboxId = Number(request.params.outboxId);
    if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
      return sendError(
        reply,
        400,
        "NOTIFICATION_RECONCILIATION_INVALID",
        "Notification reconciliation request is invalid",
      );
    }

    let body: ReturnType<typeof parseReconciliationBody>;
    try {
      body = parseReconciliationBody(request.body);
    } catch {
      return sendError(
        reply,
        400,
        "NOTIFICATION_RECONCILIATION_INVALID",
        "Notification reconciliation request is invalid",
      );
    }

    let result: NotificationProviderReconciliationResult;
    try {
      result = await reconcile({
        outboxId,
        ...body,
        actor: {
          userId: actor.id,
          username: actor.username,
          teamId: actor.teamId,
        },
      });
    } catch {
      return sendError(
        reply,
        503,
        "NOTIFICATION_RECONCILIATION_UNAVAILABLE",
        "Notification reconciliation is unavailable",
      );
    }

    if (result.state === "missing") {
      return sendError(
        reply,
        404,
        "NOTIFICATION_OUTBOX_NOT_FOUND",
        "Notification outbox row was not found",
      );
    }
    if (result.state === "conflict") {
      return sendError(
        reply,
        409,
        "NOTIFICATION_RECONCILIATION_CONFLICT",
        "Notification delivery state changed; refresh evidence before retrying",
      );
    }
    return sendSuccess(reply, { outboxId, status: result.status });
  });
};
