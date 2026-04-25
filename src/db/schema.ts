import { sql } from "drizzle-orm";
import { bigint, datetime, index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const spxBookingHistory = mysqlTable("spx_booking_history", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  requestId: bigint("request_id", { mode: "number", unsigned: true }).notNull(),
  bookingId: bigint("booking_id", { mode: "number", unsigned: true }),
  bookingName: varchar("booking_name", { length: 255 }),
  agencyName: varchar("agency_name", { length: 255 }),
  route: varchar("route", { length: 255 }).notNull(),
  origin: varchar("origin", { length: 255 }),
  destination: varchar("destination", { length: 255 }),
  costType: varchar("cost_type", { length: 50 }),
  tripType: varchar("trip_type", { length: 50 }),
  shiftType: varchar("shift_type", { length: 50 }),
  vehicleType: varchar("vehicle_type", { length: 50 }),
  standbyDateTime: varchar("standby_datetime", { length: 50 }),
  acceptanceStatus: int("acceptance_status"),
  assignmentStatus: int("assignment_status"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  requestIdIdx: uniqueIndex("request_id_idx").on(table.requestId),
  bookingIdIdx: index("booking_id_idx").on(table.bookingId),
  createdAtIdx: index("created_at_idx").on(table.createdAt),
}));

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditLogs = mysqlTable("audit_logs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  username: varchar("username", { length: 50 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  details: varchar("details", { length: 1000 }),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
