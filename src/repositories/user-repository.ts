import { ensureDashboardTables, getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import type { UserRole } from "../services/authz.js";

const BCRYPT_ROUNDS = 12;

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
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
}

export async function getUserAuthStateById(id: number): Promise<{ id: number; username: string; role: UserRole; authVersion: number } | null> {
  const db = await getDb();
  const [user] = await db
    .select({ id: users.id, username: users.username, role: users.role, authVersion: users.authVersion })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!user) return null;
  return { ...user, role: user.role === "admin" ? "admin" : "user" };
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
    await db.insert(users).values({ username, passwordHash, role, createdAt: sql`CURRENT_TIMESTAMP` });
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
  return db.select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt }).from(users);
}

export async function createUser(username: string, passwordPlain: string, role: UserRole = "user") {
  const db = await getDb();
  const passwordHash = await hashPassword(passwordPlain);
  await db.insert(users).values({ username, passwordHash, role, createdAt: sql`CURRENT_TIMESTAMP` });
}

export async function updateUserPassword(id: number, newPasswordPlain: string): Promise<boolean> {
  const db = await getDb();
  const passwordHash = await hashPassword(newPasswordPlain);
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  await db.update(users).set({ passwordHash, authVersion: current.authVersion + 1 }).where(eq(users.id, id));
  return true;
}

export async function updateUserRole(id: number, role: UserRole): Promise<boolean> {
  const db = await getDb();
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  await db.update(users).set({ role, authVersion: current.authVersion + 1 }).where(eq(users.id, id));
  return true;
}

export async function deleteUser(id: number): Promise<boolean> {
  const db = await getDb();
  const current = await getUserAuthStateById(id);
  if (!current) return false;
  await db.delete(users).where(eq(users.id, id));
  return true;
}
