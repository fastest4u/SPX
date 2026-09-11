import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import type { AuthUser } from "./authz.js";
import type { NotifyRule, NotifyRuleInput } from "./notify-rules.js";

export const MAX_RULE_REVIEW_TOKEN_LENGTH = 4096;
const REVIEW_TTL_MS = 5 * 60 * 1000;
const TOKEN_DOMAIN = "spx:rule-activation-review:v1:";
// HTTP production validates JWT_SECRET during startup. Unconfigured development
// processes get private, short-lived tokens that cannot survive their restart.
const signingKey = env.JWT_SECRET || randomBytes(32);
const filterFields = ["origins", "destinations", "vehicle_types"] as const;
type WildcardField = typeof filterFields[number];

export interface ActivationReviewInput {
  token: string;
  acknowledgeWildcard?: boolean;
  acknowledgeAcceptAll?: boolean;
}

export interface RuleActivationReview {
  token: string;
  expiresAt: string;
  wildcardFields: WildcardField[];
  acceptAll: boolean;
}

export interface RuleReviewContext {
  user: AuthUser;
  teamId: number;
  rule: NotifyRuleInput;
  existing?: NotifyRule;
}

function ruleValues(rule: NotifyRuleInput): Required<NotifyRuleInput> {
  return {
    name: rule.name,
    origins: rule.origins ?? [],
    destinations: rule.destinations ?? [],
    vehicle_types: rule.vehicle_types ?? [],
    need: rule.need ?? 1,
    enabled: rule.enabled ?? true,
    fulfilled: rule.fulfilled ?? false,
    accept_all: rule.accept_all ?? false,
    auto_accepted: rule.auto_accepted ?? false,
  };
}

export function ruleReviewSnapshot(rule: NotifyRule): string {
  return JSON.stringify({ id: rule.id, teamId: rule.teamId ?? 1, rule: ruleValues(rule) });
}

export function ruleReviewChanged(): AppError {
  return new AppError("This rule or its remaining target changed. Reload it and preview again before activating.", 409, "RULE_REVIEW_CHANGED");
}

function binding(context: RuleReviewContext): string {
  return createHash("sha256").update(JSON.stringify({
    actorId: context.user.id,
    actorRole: context.user.role,
    actorTeamId: context.user.teamId,
    teamId: context.teamId,
    target: context.existing?.id ?? "create",
    rule: ruleValues(context.rule),
    existing: context.existing ? ruleReviewSnapshot(context.existing) : null,
  })).digest("hex");
}

function wildcardFields(rule: NotifyRuleInput): WildcardField[] {
  return filterFields.filter((field) => (rule[field]?.length ?? 0) === 0);
}

function sign(payload: string): Buffer {
  return createHmac("sha256", signingKey).update(TOKEN_DOMAIN).update(payload).digest();
}

export function createRuleActivationReview(context: RuleReviewContext): RuleActivationReview {
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, expiresAt, binding: binding(context) })).toString("base64url");
  return {
    token: `${payload}.${sign(payload).toString("hex")}`,
    expiresAt: new Date(expiresAt).toISOString(),
    wildcardFields: wildcardFields(context.rule),
    acceptAll: context.rule.accept_all === true,
  };
}

export function requiresRuleActivationReview(rule: NotifyRuleInput): boolean {
  return rule.enabled !== false && (rule.need ?? 1) > 0 && rule.fulfilled !== true;
}

/** An intent gate only: route authentication and team/mode permissions run first. */
export function verifyRuleActivationReview(context: RuleReviewContext, review?: ActivationReviewInput): boolean {
  if (!requiresRuleActivationReview(context.rule)) return false;
  const required = () => new AppError("Preview this rule and acknowledge its warnings before activating.", 409, "RULE_REVIEW_REQUIRED");
  const token = review?.token;
  if (typeof token !== "string" || token.length > MAX_RULE_REVIEW_TOKEN_LENGTH) throw required();
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw required();
  const [, payload, signature] = match;
  // Fixed-size validated digest buffers avoid length errors and use a safe comparison.
  if (!timingSafeEqual(sign(payload), Buffer.from(signature, "hex"))) throw required();
  let decoded: { v?: unknown; expiresAt?: unknown; binding?: unknown };
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw required(); }
  if (!decoded || decoded.v !== 1 || typeof decoded.expiresAt !== "number" || !Number.isSafeInteger(decoded.expiresAt)) throw required();
  if (Date.now() >= decoded.expiresAt) {
    throw new AppError("This review expired. Preview the rule again before activating.", 409, "RULE_REVIEW_EXPIRED");
  }
  if (decoded.binding !== binding(context)) throw ruleReviewChanged();
  if (wildcardFields(context.rule).length > 0 && review?.acknowledgeWildcard !== true) throw required();
  if (context.rule.accept_all === true && review?.acknowledgeAcceptAll !== true) throw required();
  return true;
}

export function ruleActivationAuditSummary(rule: NotifyRuleInput, reviewed: boolean, review?: ActivationReviewInput): string {
  return `accept_all=${rule.accept_all === true}; activationReviewed=${reviewed}; acknowledgeWildcard=${reviewed && review?.acknowledgeWildcard === true}; acknowledgeAcceptAll=${reviewed && review?.acknowledgeAcceptAll === true}`;
}
