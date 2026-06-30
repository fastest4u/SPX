import { desc, eq } from "drizzle-orm";
import { ensureDashboardTables, getDb } from "../db/client.js";
import { teams } from "../db/schema.js";
import { decryptString, encryptString } from "../utils/crypto.js";
import { getAppSettings } from "./app-settings-repository.js";

const REDACTED_PREFIX = "********";
const LEGACY_TEAM_SETTING_KEYS = [
  "COOKIE",
  "DEVICE_ID",
  "LINE_USER_ID",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS",
  "LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE",
] as const;

export interface TeamInput {
  name: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
  autoAcceptSuccessLineGroupId?: string;
  autoAcceptFailureLineGroupId?: string;
}

export interface TeamPatch {
  name?: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
  autoAcceptSuccessLineGroupId?: string;
  autoAcceptFailureLineGroupId?: string;
}

export interface RedactedTeam {
  id: number;
  name: string;
  enabled: boolean;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
  hasLineGroupId: boolean;
  hasAutoAcceptSuccessLineGroupId: boolean;
  hasAutoAcceptFailureLineGroupId: boolean;
  spxCookiePreview: string;
  spxDeviceIdPreview: string;
  lineGroupIdPreview: string;
  autoAcceptSuccessLineGroupIdPreview: string;
  autoAcceptFailureLineGroupIdPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRuntimeConfig {
  id: number;
  name: string;
  enabled: boolean;
  spxCookie: string;
  spxDeviceId: string;
  lineGroupId: string;
  autoAcceptSuccessLineGroupId: string;
  autoAcceptFailureLineGroupId: string;
}

type TeamRow = typeof teams.$inferSelect;

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

function toRedactedTeam(row: TeamRow): RedactedTeam {
  const spxCookie = decodeSecret(row.spxCookie);
  const spxDeviceId = decodeSecret(row.spxDeviceId);
  const lineGroupId = decodeSecret(row.lineGroupId);
  const autoAcceptSuccessLineGroupId = decodeSecret(row.autoAcceptSuccessLineGroupId);
  const autoAcceptFailureLineGroupId = decodeSecret(row.autoAcceptFailureLineGroupId);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    hasSpxCookie: spxCookie.length > 0,
    hasSpxDeviceId: spxDeviceId.length > 0,
    hasLineGroupId: lineGroupId.length > 0,
    hasAutoAcceptSuccessLineGroupId: autoAcceptSuccessLineGroupId.length > 0,
    hasAutoAcceptFailureLineGroupId: autoAcceptFailureLineGroupId.length > 0,
    spxCookiePreview: previewSecret(spxCookie),
    spxDeviceIdPreview: previewSecret(spxDeviceId),
    lineGroupIdPreview: previewSecret(lineGroupId),
    autoAcceptSuccessLineGroupIdPreview: previewSecret(autoAcceptSuccessLineGroupId),
    autoAcceptFailureLineGroupIdPreview: previewSecret(autoAcceptFailureLineGroupId),
    createdAt: asDateString(row.createdAt),
    updatedAt: asDateString(row.updatedAt),
  };
}

function toRuntimeConfig(row: TeamRow): TeamRuntimeConfig {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    spxCookie: decodeSecret(row.spxCookie),
    spxDeviceId: decodeSecret(row.spxDeviceId),
    lineGroupId: decodeSecret(row.lineGroupId),
    autoAcceptSuccessLineGroupId: decodeSecret(row.autoAcceptSuccessLineGroupId),
    autoAcceptFailureLineGroupId: decodeSecret(row.autoAcceptFailureLineGroupId),
  };
}

function shouldBackfillLegacyTarget(currentTarget: string, lineGroupId: string, legacyTarget: string): boolean {
  return legacyTarget.length > 0 && (currentTarget.length === 0 || currentTarget === lineGroupId);
}

async function getTeamRowById(id: number): Promise<TeamRow | null> {
  await ensureDashboardTables();
  const db = getDb();
  const [row] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return row ?? null;
}

export async function listTeams(): Promise<RedactedTeam[]> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = await db.select().from(teams);
  return rows.map(toRedactedTeam);
}

export async function getTeamById(id: number): Promise<RedactedTeam | null> {
  const row = await getTeamRowById(id);
  return row ? toRedactedTeam(row) : null;
}

export async function getTeamRuntimeConfig(id: number): Promise<TeamRuntimeConfig | null> {
  const row = await getTeamRowById(id);
  return row ? toRuntimeConfig(row) : null;
}

export async function listEnabledTeamRuntimeConfigs(): Promise<TeamRuntimeConfig[]> {
  await ensureDashboardTables();
  const db = getDb();
  const rows = await db.select().from(teams).where(eq(teams.enabled, 1));
  return rows.map(toRuntimeConfig);
}

export async function createTeam(input: TeamInput): Promise<RedactedTeam> {
  await ensureDashboardTables();
  const db = getDb();
  await db.insert(teams).values({
    name: input.name.trim(),
    enabled: input.enabled === false ? 0 : 1,
    spxCookie: encodeSecret(input.spxCookie),
    spxDeviceId: encodeSecret(input.spxDeviceId),
    lineGroupId: encodeSecret(input.lineGroupId),
    autoAcceptSuccessLineGroupId: encodeSecret(input.autoAcceptSuccessLineGroupId || input.lineGroupId),
    autoAcceptFailureLineGroupId: encodeSecret(input.autoAcceptFailureLineGroupId || input.lineGroupId),
  });

  const [row] = await db.select().from(teams).orderBy(desc(teams.id)).limit(1);
  return toRedactedTeam(row);
}

export async function updateTeam(id: number, patch: TeamPatch): Promise<RedactedTeam | null> {
  const current = await getTeamRowById(id);
  if (!current) return null;

  const next: Partial<typeof teams.$inferInsert> = { updatedAt: new Date() };
  if (typeof patch.name === "string") next.name = patch.name.trim();
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled ? 1 : 0;
  if (patch.spxCookie !== undefined && !isRedactedPlaceholder(patch.spxCookie)) next.spxCookie = encodeSecret(patch.spxCookie);
  if (patch.spxDeviceId !== undefined && !isRedactedPlaceholder(patch.spxDeviceId)) next.spxDeviceId = encodeSecret(patch.spxDeviceId);
  if (patch.lineGroupId !== undefined && !isRedactedPlaceholder(patch.lineGroupId)) next.lineGroupId = encodeSecret(patch.lineGroupId);
  if (patch.autoAcceptSuccessLineGroupId !== undefined && !isRedactedPlaceholder(patch.autoAcceptSuccessLineGroupId)) {
    next.autoAcceptSuccessLineGroupId = encodeSecret(patch.autoAcceptSuccessLineGroupId);
  }
  if (patch.autoAcceptFailureLineGroupId !== undefined && !isRedactedPlaceholder(patch.autoAcceptFailureLineGroupId)) {
    next.autoAcceptFailureLineGroupId = encodeSecret(patch.autoAcceptFailureLineGroupId);
  }

  const db = getDb();
  await db.update(teams).set(next).where(eq(teams.id, id));
  return getTeamById(id);
}

export async function disableTeam(id: number): Promise<boolean> {
  const updated = await updateTeam(id, { enabled: false });
  return updated !== null;
}

export async function ensureDefaultTeamFromLegacySettings(): Promise<RedactedTeam> {
  const existing = await getTeamRowById(1);
  const legacy = await getAppSettings([...LEGACY_TEAM_SETTING_KEYS]);
  if (existing) {
    const lineGroupId = decodeSecret(existing.lineGroupId);
    const autoAcceptSuccessLineGroupId = decodeSecret(existing.autoAcceptSuccessLineGroupId);
    const autoAcceptFailureLineGroupId = decodeSecret(existing.autoAcceptFailureLineGroupId);
    const next: Partial<typeof teams.$inferInsert> = {};
    if (shouldBackfillLegacyTarget(autoAcceptSuccessLineGroupId, lineGroupId, legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS)) {
      next.autoAcceptSuccessLineGroupId = encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS);
    }
    if (shouldBackfillLegacyTarget(autoAcceptFailureLineGroupId, lineGroupId, legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE)) {
      next.autoAcceptFailureLineGroupId = encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE);
    }
    if (Object.keys(next).length > 0) {
      next.updatedAt = new Date();
      const db = getDb();
      await db.update(teams).set(next).where(eq(teams.id, 1));
    }
    const upgraded = await getTeamById(1);
    if (!upgraded) throw new Error("Failed to read Default Team");
    return upgraded;
  }

  await ensureDashboardTables();
  const db = getDb();
  await db.insert(teams).values({
    id: 1,
    name: "Default Team",
    enabled: 1,
    spxCookie: encodeSecret(legacy.COOKIE),
    spxDeviceId: encodeSecret(legacy.DEVICE_ID),
    lineGroupId: encodeSecret(legacy.LINE_USER_ID),
    autoAcceptSuccessLineGroupId: encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || legacy.LINE_USER_ID),
    autoAcceptFailureLineGroupId: encodeSecret(legacy.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || legacy.LINE_USER_ID),
  });
  const created = await getTeamById(1);
  if (!created) throw new Error("Failed to create Default Team");
  return created;
}
