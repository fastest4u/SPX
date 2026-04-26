/**
 * Test script for DB_MODE=memory
 * Verifies that SQLite in-memory database works correctly
 */

import { closePool, getDb, getPool } from "../db/client.js";
import { users, auditLogs, spxBookingHistory } from "../db/schema.js";
import { desc } from "drizzle-orm";

async function runTests(): Promise<void> {
  console.log("🧪 Testing DB_MODE=memory...\n");

  // Test 1: Verify pool is null (memory mode doesn't use mysql2 pool)
  const pool = getPool();
  if (pool !== null) {
    throw new Error("Expected pool to be null in memory mode");
  }
  console.log("✓ Pool is null (memory mode active)");

  // Test 2: Get Drizzle DB instance
  const db = getDb();
  if (!db) {
    throw new Error("Failed to get DB instance");
  }
  console.log("✓ Drizzle DB instance created");

  // Test 3: Insert a user
  const insertResult = await db.insert(users).values({
    username: "test_user",
    passwordHash: "hashed_password_123",
    role: "viewer",
  }).returning();
  
  if (insertResult.length !== 1) {
    throw new Error("Failed to insert user");
  }
  console.log("✓ Inserted user:", insertResult[0].username);

  // Test 4: Query users
  const allUsers = await db.select().from(users);
  if (allUsers.length !== 1) {
    throw new Error(`Expected 1 user, got ${allUsers.length}`);
  }
  console.log("✓ Queried users:", allUsers.length, "rows");

  // Test 5: Insert audit log
  const auditResult = await db.insert(auditLogs).values({
    username: "test_user",
    action: "TEST_ACTION",
    details: "Test audit log entry",
  }).returning();
  
  if (auditResult.length !== 1) {
    throw new Error("Failed to insert audit log");
  }
  console.log("✓ Inserted audit log:", auditResult[0].action);

  // Test 6: Query audit logs
  const allLogs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(10);
  console.log("✓ Queried audit logs:", allLogs.length, "rows");

  // Test 7: Insert booking history
  const bookingResult = await db.insert(spxBookingHistory).values({
    requestId: 12345,
    route: "BKK-CNX",
    origin: "Bangkok",
    destination: "Chiang Mai",
    vehicleType: "6W",
    bookingId: 99999,
    bookingName: "Test Booking",
    agencyName: "Test Agency",
  }).returning();

  if (bookingResult.length !== 1) {
    throw new Error("Failed to insert booking history");
  }
  console.log("✓ Inserted booking:", bookingResult[0].route);

  // Test 8: Query booking history
  const allBookings = await db.select().from(spxBookingHistory);
  if (allBookings.length !== 1) {
    throw new Error(`Expected 1 booking, got ${allBookings.length}`);
  }
  console.log("✓ Queried bookings:", allBookings.length, "rows");

  console.log("\n✅ All memory DB tests passed!");
}

async function main(): Promise<void> {
  try {
    await runTests();
  } catch (error) {
    console.error("\n❌ Test failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
