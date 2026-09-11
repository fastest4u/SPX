import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { teams } from "../db/schema.js";
import type {
  ProviderAuthErrorCode,
  ProviderAuthLease,
  ProviderAuthRecord,
  ProviderAuthState,
  ProviderAuthStatus,
  ProviderCredentials,
  ProviderSession,
} from "../models/provider-auth.js";
import { decryptString, encryptString } from "../utils/crypto.js";

const AUTH_LEASE_TTL_MS = 120_000;
type TeamRow = typeof teams.$inferSelect;

function formatDbTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function dbTimestamp(value: Date) {
  return sql`${formatDbTimestamp(value)}`;
}

function optionalDbTimestamp(value: string | null) {
  return value === null ? null : dbTimestamp(new Date(value));
}

function asIsoString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function affectedRows(result: unknown): number | null {
  if (Array.isArray(result)) return affectedRows(result[0]);
  if (!result || typeof result !== "object") return null;
  for (const key of ["affectedRows", "changes", "rowsAffected"]) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function isProviderAuthState(value: string): value is ProviderAuthState {
  return value === "manual" || value === "connected" || value === "connecting" || value === "attention" || value === "retry_wait";
}

function storedState(value: string): ProviderAuthState {
  return isProviderAuthState(value) ? value : "attention";
}

function activeLease(row: TeamRow, now = new Date()): boolean {
  const until = asIsoString(row.spxAuthLeaseUntil);
  return Boolean(row.spxAuthLeaseToken && until && Date.parse(until) > now.getTime());
}

function toStatus(row: TeamRow): ProviderAuthStatus {
  const password = decryptString(row.spxPassword);
  return {
    teamId: row.id,
    email: row.spxEmail,
    hasPassword: password.length > 0,
    status: activeLease(row) ? "connecting" : storedState(row.spxAuthStatus),
    lastLoginAt: asIsoString(row.spxLastLoginAt),
    expiresAt: asIsoString(row.spxSessionExpiresAt),
    errorCode: row.spxAuthError as ProviderAuthErrorCode | null,
    retryAt: asIsoString(row.spxAuthRetryAt),
  };
}

function toRecord(row: TeamRow): ProviderAuthRecord {
  return {
    ...toStatus(row),
    storedStatus: storedState(row.spxAuthStatus),
    password: decryptString(row.spxPassword),
    cookie: decryptString(row.spxCookie),
    deviceId: decryptString(row.spxDeviceId),
    epoch: row.spxAuthEpoch,
    failures: row.spxAuthFailures,
    enabled: row.enabled === 1,
  };
}

async function getTeamRow(teamId: number): Promise<TeamRow | null> {
  await ensureDashboardTables();
  const db = getDb();
  const [row] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  return row ?? null;
}

export async function getTeamProviderAuth(teamId: number): Promise<ProviderAuthRecord | null> {
  const row = await getTeamRow(teamId);
  return row ? toRecord(row) : null;
}

export async function getTeamProviderAuthStatus(teamId: number): Promise<ProviderAuthStatus | null> {
  const row = await getTeamRow(teamId);
  return row ? toStatus(row) : null;
}

export async function acquireTeamProviderAuthLease(teamId: number, now = new Date()): Promise<ProviderAuthLease | null> {
  await ensureDashboardTables();
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const result = await db
    .update(teams)
    .set({
      spxAuthLeaseToken: token,
      spxAuthLeaseUntil: dbTimestamp(new Date(now.getTime() + AUTH_LEASE_TTL_MS)),
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      eq(teams.id, teamId),
      or(
        isNull(teams.spxAuthLeaseToken),
        isNull(teams.spxAuthLeaseUntil),
        lte(teams.spxAuthLeaseUntil, dbTimestamp(now)),
      ),
    ));

  if (affectedRows(result) === 0) return null;
  const [owned] = await db
    .select({ epoch: teams.spxAuthEpoch, token: teams.spxAuthLeaseToken })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.spxAuthLeaseToken, token)))
    .limit(1);
  if (!owned || owned.token !== token) return null;
  return { teamId, token, epoch: owned.epoch };
}

export async function commitTeamProviderAuth(
  lease: ProviderAuthLease,
  credentials: ProviderCredentials,
  session: ProviderSession,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = getDb();
  const result = await db
    .update(teams)
    .set({
      spxEmail: credentials.email.trim().toLowerCase(),
      spxPassword: encryptString(credentials.password),
      spxCookie: encryptString(session.cookie),
      spxDeviceId: encryptString(session.deviceId),
      spxAuthStatus: "connected",
      spxAuthError: null,
      spxAuthRetryAt: null,
      spxAuthFailures: 0,
      spxSessionExpiresAt: optionalDbTimestamp(session.expiresAt),
      spxLastLoginAt: dbTimestamp(now),
      spxAuthEpoch: sql`${teams.spxAuthEpoch} + 1`,
      spxAuthLeaseToken: null,
      spxAuthLeaseUntil: null,
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      eq(teams.id, lease.teamId),
      eq(teams.spxAuthLeaseToken, lease.token),
      eq(teams.spxAuthEpoch, lease.epoch),
      gt(teams.spxAuthLeaseUntil, dbTimestamp(now)),
    ));
  return (affectedRows(result) ?? 0) > 0;
}

export async function failTeamProviderAuth(
  lease: ProviderAuthLease,
  failure: {
    status: ProviderAuthState;
    errorCode: ProviderAuthErrorCode;
    retryAt: string | null;
    failures: number;
  },
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = getDb();
  const result = await db
    .update(teams)
    .set({
      spxAuthStatus: failure.status,
      spxAuthError: failure.errorCode,
      spxAuthRetryAt: optionalDbTimestamp(failure.retryAt),
      spxAuthFailures: failure.failures,
      spxAuthLeaseToken: null,
      spxAuthLeaseUntil: null,
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      eq(teams.id, lease.teamId),
      eq(teams.spxAuthLeaseToken, lease.token),
      eq(teams.spxAuthEpoch, lease.epoch),
      gt(teams.spxAuthLeaseUntil, dbTimestamp(now)),
    ));
  return (affectedRows(result) ?? 0) > 0;
}

export async function releaseTeamProviderAuthLease(
  lease: ProviderAuthLease,
  now = new Date(),
): Promise<boolean> {
  await ensureDashboardTables();
  const db = getDb();
  const result = await db
    .update(teams)
    .set({
      spxAuthLeaseToken: null,
      spxAuthLeaseUntil: null,
      updatedAt: dbTimestamp(now),
    })
    .where(and(
      eq(teams.id, lease.teamId),
      eq(teams.spxAuthLeaseToken, lease.token),
      eq(teams.spxAuthEpoch, lease.epoch),
      gt(teams.spxAuthLeaseUntil, dbTimestamp(now)),
    ));
  return (affectedRows(result) ?? 0) > 0;
}
