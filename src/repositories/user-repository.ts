import { ensureDashboardTables, getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { UserRole } from "../services/authz.js";

const BCRYPT_ROUNDS = 12;

export async function getUserByUsername(username: string) {
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
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
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.insert(users).values({ username, passwordHash, role, createdAt: sql`CURRENT_TIMESTAMP` });
  }
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function getAllUsers() {
  const db = await getDb();
  return db.select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt }).from(users);
}

export async function createUser(username: string, passwordPlain: string, role: UserRole = "user") {
  const db = await getDb();
  const passwordHash = await bcrypt.hash(passwordPlain, BCRYPT_ROUNDS);
  await db.insert(users).values({ username, passwordHash, role, createdAt: sql`CURRENT_TIMESTAMP` });
}

export async function updateUserPassword(id: number, newPasswordPlain: string) {
  const db = await getDb();
  const passwordHash = await bcrypt.hash(newPasswordPlain, BCRYPT_ROUNDS);
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

export async function updateUserRole(id: number, role: UserRole) {
  const db = await getDb();
  await db.update(users).set({ role }).where(eq(users.id, id));
}

export async function deleteUser(id: number) {
  const db = await getDb();
  await db.delete(users).where(eq(users.id, id));
}
