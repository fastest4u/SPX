import { ensureDashboardTables, getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { UserRole } from "../services/authz.js";

export async function getUserByUsername(username: string) {
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user;
}

export async function createAdminUserIfNotExists(username = "admin", password = "admin123", role: UserRole = "admin") {
  await ensureDashboardTables();
  const db = await getDb();
  const admin = await getUserByUsername(username);
  if (!admin) {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.insert(users).values({ username, passwordHash, role, createdAt: sql`UTC_TIMESTAMP()` });
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
  const passwordHash = await bcrypt.hash(passwordPlain, 10);
  await db.insert(users).values({ username, passwordHash, role, createdAt: sql`UTC_TIMESTAMP()` });
}

export async function updateUserPassword(id: number, newPasswordPlain: string) {
  const db = await getDb();
  const passwordHash = await bcrypt.hash(newPasswordPlain, 10);
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
