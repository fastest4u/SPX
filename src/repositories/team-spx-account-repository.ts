import { and, desc, eq } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { teamSpxAccounts } from "../db/schema.js";
import { decryptString, encryptString } from "../utils/crypto.js";

const REDACTED_PREFIX = "[REDACTED:";

export interface TeamSpxAccountRuntime {
  id: number;
  teamId: number;
  name: string;
  spxEmail: string;
  spxPassword?: string;
  spxCookie: string;
  spxDeviceId: string;
  spxAppName: string;
  spxReferer: string;
  spxAuthStatus: string;
  spxAuthError: string | null;
  spxSessionExpiresAt: string | null;
  spxLastLoginAt: string | null;
  enabled: boolean;
}

export interface RedactedTeamSpxAccount {
  id: number;
  teamId: number;
  name: string;
  email: string;
  hasPassword: boolean;
  spxAuthStatus: string;
  spxAuthError: string | null;
  spxSessionExpiresAt: string | null;
  spxLastLoginAt: string | null;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
  spxCookiePreview: string;
  spxDeviceIdPreview: string;
  spxAppName: string;
  spxReferer: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamSpxAccountInput {
  teamId: number;
  name: string;
  spxEmail?: string;
  spxPassword?: string;
  spxCookie?: string;
  spxDeviceId?: string;
  spxAppName?: string;
  spxReferer?: string;
  spxAuthStatus?: string;
  spxAuthError?: string | null;
  spxSessionExpiresAt?: Date | null;
  spxLastLoginAt?: Date | null;
  enabled?: boolean;
}

export interface UpdateTeamSpxAccountInput {
  name?: string;
  spxEmail?: string;
  spxPassword?: string;
  spxCookie?: string;
  spxDeviceId?: string;
  spxAppName?: string;
  spxReferer?: string;
  spxAuthStatus?: string;
  spxAuthError?: string | null;
  spxSessionExpiresAt?: Date | null;
  spxLastLoginAt?: Date | null;
  enabled?: boolean;
}

type AccountRow = typeof teamSpxAccounts.$inferSelect;

function isRedactedPlaceholder(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(REDACTED_PREFIX);
}

function encodeSecret(value: string | undefined): string {
  if (!value) return "";
  return encryptString(value);
}

function decodeSecret(value: string | null | undefined): string {
  return decryptString(value);
}

function previewSecret(value: string): string {
  if (!value) return "";
  return `${REDACTED_PREFIX}${value.slice(-4)}`;
}

function asDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value ?? "");
}

function toRedactedAccount(row: AccountRow): RedactedTeamSpxAccount {
  const spxCookie = decodeSecret(row.spxCookie);
  const spxDeviceId = decodeSecret(row.spxDeviceId);
  const spxPassword = decodeSecret(row.spxPassword);
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    email: row.spxEmail || row.name,
    hasPassword: spxPassword.length > 0,
    spxAuthStatus: row.spxAuthStatus ?? "connected",
    spxAuthError: row.spxAuthError ?? null,
    spxSessionExpiresAt: row.spxSessionExpiresAt ? asDateString(row.spxSessionExpiresAt) : null,
    spxLastLoginAt: row.spxLastLoginAt ? asDateString(row.spxLastLoginAt) : null,
    hasSpxCookie: spxCookie.length > 0,
    hasSpxDeviceId: spxDeviceId.length > 0,
    spxCookiePreview: previewSecret(spxCookie),
    spxDeviceIdPreview: previewSecret(spxDeviceId),
    spxAppName: row.spxAppName ?? "",
    spxReferer: row.spxReferer ?? "",
    enabled: row.enabled === 1,
    createdAt: asDateString(row.createdAt),
    updatedAt: asDateString(row.updatedAt),
  };
}

function toRuntimeAccount(row: AccountRow): TeamSpxAccountRuntime {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    spxEmail: row.spxEmail || row.name,
    spxPassword: decodeSecret(row.spxPassword) || undefined,
    spxCookie: decodeSecret(row.spxCookie),
    spxDeviceId: decodeSecret(row.spxDeviceId),
    spxAppName: row.spxAppName ?? "",
    spxReferer: row.spxReferer ?? "",
    spxAuthStatus: row.spxAuthStatus ?? "connected",
    spxAuthError: row.spxAuthError ?? null,
    spxSessionExpiresAt: row.spxSessionExpiresAt ? asDateString(row.spxSessionExpiresAt) : null,
    spxLastLoginAt: row.spxLastLoginAt ? asDateString(row.spxLastLoginAt) : null,
    enabled: row.enabled === 1,
  };
}

async function getAccountRowById(id: number): Promise<AccountRow | null> {
  await ensureDashboardTables();
  const db = getDb();
  const [row] = await db.select().from(teamSpxAccounts).where(eq(teamSpxAccounts.id, id)).limit(1);
  return row ?? null;
}

export async function listAccountsByTeam(
  teamId: number,
  onlyEnabled = false,
): Promise<RedactedTeamSpxAccount[]> {
  await ensureDashboardTables();
  const db = getDb();
  const conditions = [eq(teamSpxAccounts.teamId, teamId)];
  if (onlyEnabled) {
    conditions.push(eq(teamSpxAccounts.enabled, 1));
  }
  const rows = await db
    .select()
    .from(teamSpxAccounts)
    .where(and(...conditions))
    .orderBy(desc(teamSpxAccounts.id));
  return rows.map(toRedactedAccount);
}

export async function getRuntimeAccountsByTeam(teamId: number): Promise<TeamSpxAccountRuntime[]> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = await db
    .select()
    .from(teamSpxAccounts)
    .where(and(eq(teamSpxAccounts.teamId, teamId), eq(teamSpxAccounts.enabled, 1)))
    .orderBy(teamSpxAccounts.id);
  return rows.map(toRuntimeAccount);
}

export async function getAccountById(id: number): Promise<RedactedTeamSpxAccount | null> {
  const row = await getAccountRowById(id);
  return row ? toRedactedAccount(row) : null;
}

export async function getRuntimeAccountById(id: number): Promise<TeamSpxAccountRuntime | null> {
  const row = await getAccountRowById(id);
  return row ? toRuntimeAccount(row) : null;
}

export async function createAccount(
  input: CreateTeamSpxAccountInput,
): Promise<RedactedTeamSpxAccount> {
  await ensureDashboardTables();
  const db = getDb();
  const rowToInsert: typeof teamSpxAccounts.$inferInsert = {
    teamId: input.teamId,
    name: input.name.trim(),
    spxEmail: (input.spxEmail ?? input.name).trim(),
    spxPassword: input.spxPassword ? encodeSecret(input.spxPassword) : null,
    spxCookie: encodeSecret(input.spxCookie),
    spxDeviceId: encodeSecret(input.spxDeviceId),
    spxAppName: input.spxAppName?.trim() || "",
    spxReferer: input.spxReferer?.trim() || "",
    spxAuthStatus: input.spxAuthStatus ?? "connected",
    spxAuthError: input.spxAuthError ?? null,
    spxSessionExpiresAt: input.spxSessionExpiresAt ?? null,
    spxLastLoginAt: input.spxLastLoginAt ?? new Date(),
    enabled: input.enabled === false ? 0 : 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(teamSpxAccounts).values(rowToInsert);
  const [created] = await db
    .select()
    .from(teamSpxAccounts)
    .where(eq(teamSpxAccounts.teamId, input.teamId))
    .orderBy(desc(teamSpxAccounts.id))
    .limit(1);
  return toRedactedAccount(created);
}

export async function updateAccount(
  id: number,
  patch: UpdateTeamSpxAccountInput,
): Promise<RedactedTeamSpxAccount | null> {
  const current = await getAccountRowById(id);
  if (!current) return null;

  const next: Partial<typeof teamSpxAccounts.$inferInsert> = { updatedAt: new Date() };
  if (typeof patch.name === "string") next.name = patch.name.trim();
  if (typeof patch.spxEmail === "string") next.spxEmail = patch.spxEmail.trim();
  if (patch.spxPassword !== undefined && !isRedactedPlaceholder(patch.spxPassword)) {
    next.spxPassword = patch.spxPassword ? encodeSecret(patch.spxPassword) : null;
  }
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled ? 1 : 0;
  if (typeof patch.spxAppName === "string") next.spxAppName = patch.spxAppName.trim();
  if (typeof patch.spxReferer === "string") next.spxReferer = patch.spxReferer.trim();
  if (patch.spxCookie !== undefined && !isRedactedPlaceholder(patch.spxCookie)) {
    next.spxCookie = encodeSecret(patch.spxCookie);
  }
  if (patch.spxDeviceId !== undefined && !isRedactedPlaceholder(patch.spxDeviceId)) {
    next.spxDeviceId = encodeSecret(patch.spxDeviceId);
  }
  if (patch.spxAuthStatus !== undefined) next.spxAuthStatus = patch.spxAuthStatus;
  if (patch.spxAuthError !== undefined) next.spxAuthError = patch.spxAuthError;
  if (patch.spxSessionExpiresAt !== undefined) next.spxSessionExpiresAt = patch.spxSessionExpiresAt;
  if (patch.spxLastLoginAt !== undefined) next.spxLastLoginAt = patch.spxLastLoginAt;

  const db = getDb();
  await db.update(teamSpxAccounts).set(next).where(eq(teamSpxAccounts.id, id));
  return getAccountById(id);
}

export interface UpdateAccountSessionInput {
  spxCookie: string;
  spxDeviceId?: string;
  spxSessionExpiresAt?: Date | null;
  spxLastLoginAt?: Date | null;
  spxAuthStatus?: string;
  spxAuthError?: string | null;
}

export async function updateAccountSession(
  id: number,
  session: UpdateAccountSessionInput,
): Promise<boolean> {
  await ensureDashboardTables();
  const db = getDb();
  const next: Partial<typeof teamSpxAccounts.$inferInsert> = {
    updatedAt: new Date(),
    spxCookie: encodeSecret(session.spxCookie),
    spxLastLoginAt: session.spxLastLoginAt ?? new Date(),
  };
  if (session.spxDeviceId) {
    next.spxDeviceId = encodeSecret(session.spxDeviceId);
  }
  if (session.spxSessionExpiresAt !== undefined) {
    next.spxSessionExpiresAt = session.spxSessionExpiresAt;
  }
  if (session.spxAuthStatus !== undefined) {
    next.spxAuthStatus = session.spxAuthStatus;
  }
  if (session.spxAuthError !== undefined) {
    next.spxAuthError = session.spxAuthError;
  }
  await db.update(teamSpxAccounts).set(next).where(eq(teamSpxAccounts.id, id));
  return true;
}

export async function deleteAccount(id: number): Promise<boolean> {
  await ensureDashboardTables();
  const current = await getAccountRowById(id);
  if (!current) return false;
  const db = getDb();
  await db.delete(teamSpxAccounts).where(eq(teamSpxAccounts.id, id));
  return true;
}
