import { ensureDashboardTables, getDb } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import type { UserRole } from "../services/authz.js";

const BCRYPT_ROUNDS = 12;

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  role: UserRole;
  teamId: number | null;
  teamName: string | null;
  authVersion: number;
  createdAt: Date | string;
}

export interface UserAuthState {
  id: number;
  username: string;
  role: UserRole;
  teamId: number | null;
  teamName: string | null;
  authVersion: number;
}

export interface UserListItem {
  id: number;
  username: string;
  role: UserRole;
  teamId: number | null;
  teamName: string | null;
  createdAt: Date | string;
}

// bcrypt only consumes the first 72 bytes of its input, which makes any two
// passwords that share a 72-byte prefix interchangeable. Pre-hash to a fixed
// 44-char base64 SHA-256 digest so the entire password always contributes.
function prepareForBcrypt(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(prepareForBcrypt(password), BCRYPT_ROUNDS);
}

export async function getUserByUsername(username: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      passwordHash: users.passwordHash,
      role: users.role,
      teamId: users.teamId,
      teamName: teams.name,
      authVersion: users.authVersion,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(teams, eq(users.teamId, teams.id))
    .where(eq(users.username, username))
    .limit(1);
  return row ? normalizeUserRecord(row) : undefined;
}

export async function getUserAuthStateById(id: number): Promise<UserAuthState | null> {
  const db = await getDb();
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      teamId: users.teamId,
      teamName: teams.name,
      authVersion: users.authVersion,
    })
    .from(users)
    .leftJoin(teams, eq(users.teamId, teams.id))
    .where(eq(users.id, id))
    .limit(1);
  if (!user) return null;
  return normalizeAuthState(user);
}

export async function createAdminUserIfNotExists(username: string, password: string, role: UserRole = "admin") {
  if (!username || !password) {
    throw new Error("createAdminUserIfNotExists requires explicit username and password");
  }
  if (password.length < 12) {
    throw new Error("Admin password must be at least 12 characters long");
  }
  await ensureDashboardTables();
  const db = await getDb();
  const admin = await getUserByUsername(username);
  if (!admin) {
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ username, passwordHash, role, teamId: null, createdAt: sql`CURRENT_TIMESTAMP` });
  }
}

export async function verifyPassword(password: string, hash: string) {
  // New scheme stores bcrypt(sha256(password)). Fall back to a legacy direct
  // compare so accounts created before pre-hashing was introduced still log in.
  if (await bcrypt.compare(prepareForBcrypt(password), hash)) return true;
  return bcrypt.compare(password, hash);
}

export async function getAllUsers() {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      teamId: users.teamId,
      teamName: teams.name,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(teams, eq(users.teamId, teams.id));
  return rows.map(normalizeUserListItem);
}

export async function createUser(username: string, passwordPlain: string, role: UserRole = "user", teamId?: number | null): Promise<number> {
  const normalizedRole = normalizeRole(role);
  const normalizedTeamId = normalizeTeamForRole(normalizedRole, teamId);
  if (normalizedRole === "user" && typeof normalizedTeamId !== "number") {
    throw new Error("User role requires a teamId");
  }
  const db = await getDb();
  const passwordHash = await hashPassword(passwordPlain);
  await db.insert(users).values({ username, passwordHash, role: normalizedRole, teamId: normalizedTeamId, createdAt: sql`CURRENT_TIMESTAMP` });
  const created = await getUserByUsername(username);
  if (!created) throw new Error("Failed to create user");
  return created.id;
}

export async function updateUserPassword(id: number, newPasswordPlain: string): Promise<boolean> {
  const db = await getDb();
  const passwordHash = await hashPassword(newPasswordPlain);
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  await db.update(users).set({ passwordHash, authVersion: current.authVersion + 1 }).where(eq(users.id, id));
  return true;
}

export async function updateUserRole(id: number, role: UserRole, teamId?: number | null): Promise<boolean> {
  const db = await getDb();
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  const normalizedRole = normalizeRole(role);
  const nextTeamId = teamId === undefined ? current.teamId : teamId;
  const normalizedTeamId = normalizeTeamForRole(normalizedRole, nextTeamId);
  if (normalizedRole === "user" && typeof normalizedTeamId !== "number") return false;
  await db.update(users).set({ role: normalizedRole, teamId: normalizedTeamId, authVersion: current.authVersion + 1 }).where(eq(users.id, id));
  return true;
}

export async function updateUserTeam(id: number, teamId: number | null): Promise<boolean> {
  const db = await getDb();
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  if (current.role === "user" && typeof teamId !== "number") return false;
  await db.update(users).set({ teamId, authVersion: current.authVersion + 1 }).where(eq(users.id, id));
  return true;
}

export async function deleteUser(id: number): Promise<boolean> {
  const db = await getDb();
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  await db.delete(users).where(eq(users.id, id));
  return true;
}

function normalizeRole(role: string): UserRole {
  return role === "admin" ? "admin" : "user";
}

function normalizeTeamForRole(role: UserRole, teamId: number | null | undefined): number | null {
  if (role === "admin") return typeof teamId === "number" ? teamId : null;
  return typeof teamId === "number" ? teamId : null;
}

function normalizeAuthState(row: {
  id: number;
  username: string;
  role: string;
  teamId: number | null;
  teamName: string | null;
  authVersion: number;
}): UserAuthState {
  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    teamId: row.teamId,
    teamName: row.teamName,
    authVersion: row.authVersion,
  };
}

function normalizeUserRecord(row: {
  id: number;
  username: string;
  passwordHash: string;
  role: string;
  teamId: number | null;
  teamName: string | null;
  authVersion: number;
  createdAt: Date | string;
}): UserRecord {
  return {
    ...normalizeAuthState(row),
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
  };
}

function normalizeUserListItem(row: {
  id: number;
  username: string;
  role: string;
  teamId: number | null;
  teamName: string | null;
  createdAt: Date | string;
}): UserListItem {
  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    teamId: row.teamId,
    teamName: row.teamName,
    createdAt: row.createdAt,
  };
}
