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

export const notifyRules = mysqlTable("notify_rules", {
  id: varchar("id", { length: 255 }).primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  origins: varchar("origins", { length: 4000 }).notNull().default("[]"),
  destinations: varchar("destinations", { length: 4000 }).notNull().default("[]"),
  vehicleTypes: varchar("vehicle_types", { length: 4000 }).notNull().default("[]"),
  need: int("need").notNull().default(1),
  enabled: int("enabled").notNull().default(1),
  fulfilled: int("fulfilled").notNull().default(0),
  autoAccept: int("auto_accept").notNull().default(0),
  autoAccepted: int("auto_accepted").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const autoAcceptHistory = mysqlTable("auto_accept_history", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  ruleId: varchar("rule_id", { length: 255 }).notNull(),
  ruleName: varchar("rule_name", { length: 128 }).notNull(),
  bookingId: bigint("booking_id", { mode: "number", unsigned: true }).notNull(),
  requestIds: varchar("request_ids", { length: 2000 }).notNull(),
  acceptedCount: int("accepted_count").notNull().default(0),
  origin: varchar("origin", { length: 255 }).notNull().default(""),
  destination: varchar("destination", { length: 255 }).notNull().default(""),
  vehicleType: varchar("vehicle_type", { length: 50 }).notNull().default(""),
  status: varchar("status", { length: 20 }).notNull().default("success"),
  errorMessage: varchar("error_message", { length: 1000 }),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  createdAtIdx: index("aah_created_at_idx").on(table.createdAt),
  ruleIdIdx: index("aah_rule_id_idx").on(table.ruleId),
}));

export const metricsSnapshots = mysqlTable("metrics_snapshots", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  uptime: int("uptime").notNull(),
  totalRequests: int("total_requests").notNull().default(0),
  successCount: int("success_count").notNull().default(0),
  errorCount: int("error_count").notNull().default(0),
  successRate: varchar("success_rate", { length: 10 }).notNull().default("0"),
  latencyAvg: int("latency_avg").notNull().default(0),
  latencyP95: int("latency_p95").notNull().default(0),
  latencyP99: int("latency_p99").notNull().default(0),
  totalRecordsSeen: int("total_records_seen").notNull().default(0),
  changesDetected: int("changes_detected").notNull().default(0),
  tripsInserted: int("trips_inserted").notNull().default(0),
  tripsSkipped: int("trips_skipped").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  createdAtIdx: index("metrics_created_at_idx").on(table.createdAt),
}));
