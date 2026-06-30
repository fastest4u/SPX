import { sql } from "drizzle-orm";
import { bigint, datetime, index, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const teams = mysqlTable("teams", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  enabled: int("enabled").notNull().default(1),
  spxCookie: varchar("spx_cookie", { length: 4000 }).notNull().default(""),
  spxDeviceId: varchar("spx_device_id", { length: 1000 }).notNull().default(""),
  lineGroupId: varchar("line_group_id", { length: 255 }).notNull().default(""),
  autoAcceptSuccessLineGroupId: varchar("auto_accept_success_line_group_id", { length: 255 }).notNull().default(""),
  autoAcceptFailureLineGroupId: varchar("auto_accept_failure_line_group_id", { length: 255 }).notNull().default(""),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  enabledIdx: index("teams_enabled_idx").on(table.enabled),
  nameIdx: index("teams_name_idx").on(table.name),
}));

export const spxBookingHistory = mysqlTable("spx_booking_history", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  teamId: int("team_id").notNull().default(1),
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
  teamRequestIdIdx: uniqueIndex("spx_booking_history_team_request_uidx").on(table.teamId, table.requestId),
  bookingIdIdx: index("booking_id_idx").on(table.bookingId),
  createdAtIdx: index("created_at_idx").on(table.createdAt),
  teamCreatedAtIdx: index("spx_booking_history_team_created_idx").on(table.teamId, table.createdAt),
}));

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  teamId: int("team_id"),
  authVersion: int("auth_version").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  teamIdIdx: index("users_team_id_idx").on(table.teamId),
}));

export const auditLogs = mysqlTable("audit_logs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  teamId: int("team_id"),
  actorUserId: int("actor_user_id"),
  actorTeamId: int("actor_team_id"),
  targetTeamId: int("target_team_id"),
  username: varchar("username", { length: 50 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  details: varchar("details", { length: 1000 }),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  createdAtIdx: index("audit_created_at_idx").on(table.createdAt),
  usernameCreatedAtIdx: index("audit_username_created_at_idx").on(table.username, table.createdAt),
  actionCreatedAtIdx: index("audit_action_created_at_idx").on(table.action, table.createdAt),
  targetTeamCreatedAtIdx: index("audit_target_team_created_at_idx").on(table.targetTeamId, table.createdAt),
}));

export const notifyRules = mysqlTable("notify_rules", {
  id: varchar("id", { length: 255 }).primaryKey(),
  teamId: int("team_id").notNull().default(1),
  name: varchar("name", { length: 128 }).notNull(),
  origins: varchar("origins", { length: 4000 }).notNull().default("[]"),
  destinations: varchar("destinations", { length: 4000 }).notNull().default("[]"),
  vehicleTypes: varchar("vehicle_types", { length: 4000 }).notNull().default("[]"),
  need: int("need").notNull().default(1),
  enabled: int("enabled").notNull().default(1),
  fulfilled: int("fulfilled").notNull().default(0),
  autoAccept: int("auto_accept").notNull().default(0),
  acceptAll: int("accept_all").notNull().default(0),
  autoAccepted: int("auto_accepted").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  teamIdIdx: index("notify_rules_team_id_idx").on(table.teamId),
}));

export const autoAcceptHistory = mysqlTable("auto_accept_history", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  teamId: int("team_id").notNull().default(1),
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
  failureReason: varchar("failure_reason", { length: 64 }),
  traceId: varchar("trace_id", { length: 160 }),
  acceptRttMs: int("accept_rtt_ms"),
  listAgeMs: int("list_age_ms"),
  verificationLatencyMs: int("verification_latency_ms"),
  verificationStatus: varchar("verification_status", { length: 32 }),
  verifiedAt: datetime("verified_at"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  createdAtIdx: index("aah_created_at_idx").on(table.createdAt),
  ruleIdIdx: index("aah_rule_id_idx").on(table.ruleId),
  statusCreatedAtIdx: index("aah_status_created_at_idx").on(table.status, table.createdAt),
  teamCreatedAtIdx: index("aah_team_created_at_idx").on(table.teamId, table.createdAt),
  teamStatusCreatedAtIdx: index("aah_team_status_created_at_idx").on(table.teamId, table.status, table.createdAt),
  teamReasonCreatedAtIdx: index("aah_team_reason_created_at_idx").on(table.teamId, table.failureReason, table.createdAt),
  traceIdIdx: index("aah_trace_id_idx").on(table.traceId),
}));

export const autoAcceptAttempts = mysqlTable("auto_accept_attempts", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  traceId: varchar("trace_id", { length: 160 }).notNull(),
  teamId: int("team_id").notNull(),
  workerNodeId: varchar("worker_node_id", { length: 120 }).notNull(),
  bookingId: bigint("booking_id", { mode: "number", unsigned: true }).notNull(),
  requestIdsJson: varchar("request_ids_json", { length: 2000 }).notNull(),
  ruleId: varchar("rule_id", { length: 255 }),
  ruleName: varchar("rule_name", { length: 128 }),
  acceptMode: varchar("accept_mode", { length: 32 }).notNull(),
  acceptStartedAt: datetime("accept_started_at").notNull(),
  acceptFinishedAt: datetime("accept_finished_at"),
  acceptRttMs: int("accept_rtt_ms"),
  spxHttpStatus: int("spx_http_status"),
  spxRetcode: int("spx_retcode"),
  spxMessage: varchar("spx_message", { length: 1000 }),
  rawError: varchar("raw_error", { length: 1000 }),
  ambiguousAccept: int("ambiguous_accept").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  traceIdIdx: uniqueIndex("aaa_trace_uidx").on(table.traceId),
  teamBookingIdx: index("aaa_team_booking_idx").on(table.teamId, table.bookingId),
  workerCreatedIdx: index("aaa_worker_created_idx").on(table.workerNodeId, table.createdAt),
}));

export const autoAcceptResults = mysqlTable("auto_accept_results", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  teamId: int("team_id").notNull(),
  bookingId: bigint("booking_id", { mode: "number", unsigned: true }).notNull(),
  requestId: bigint("request_id", { mode: "number", unsigned: true }).notNull(),
  winningAttemptTraceId: varchar("winning_attempt_trace_id", { length: 160 }),
  status: varchar("status", { length: 32 }).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }).notNull(),
  evidenceJson: text("evidence_json"),
  firstSeenAt: datetime("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: datetime("resolved_at"),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  teamBookingRequestIdx: uniqueIndex("aar_team_booking_request_uidx").on(table.teamId, table.bookingId, table.requestId),
  teamStatusIdx: index("aar_team_status_idx").on(table.teamId, table.status),
  traceIdx: index("aar_trace_idx").on(table.winningAttemptTraceId),
}));

export const metricsSnapshots = mysqlTable("metrics_snapshots", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  teamId: int("team_id").notNull().default(1),
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
  teamCreatedAtIdx: index("metrics_team_created_at_idx").on(table.teamId, table.createdAt),
}));

export const lineBotSessions = mysqlTable("line_bot_sessions", {
  id: int("id").autoincrement().primaryKey(),
  sessionKey: varchar("session_key", { length: 50 }).notNull().default("default"),
  authToken: varchar("auth_token", { length: 2000 }).notNull(),
  device: varchar("device", { length: 50 }).notNull().default("IOSIPAD"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  sessionKeyIdx: uniqueIndex("lbs_session_key_idx").on(table.sessionKey),
}));

export const lineImageExtractions = mysqlTable("line_image_extractions", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  chatId: varchar("chat_id", { length: 255 }).notNull(),
  senderId: varchar("sender_id", { length: 255 }).notNull(),
  imagePath: varchar("image_path", { length: 1000 }).notNull(),
  dateText: varchar("date_text", { length: 100 }).notNull(),
  tripNumber: varchar("trip_number", { length: 100 }).notNull().default(""),
  driverName: varchar("driver_name", { length: 500 }).notNull(),
  agencyName: varchar("agency_name", { length: 100 }).notNull(),
  vehicleType: varchar("vehicle_type", { length: 100 }).notNull(),
  route: varchar("route", { length: 255 }).notNull(),
  rawText: varchar("raw_text", { length: 4000 }).notNull(),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  createdAtIdx: index("lie_created_at_idx").on(table.createdAt),
  agencyCreatedAtIdx: index("lie_agency_created_at_idx").on(table.agencyName, table.createdAt),
  tripNumberCreatedAtIdx: index("lie_trip_number_created_at_idx").on(table.tripNumber, table.createdAt),
}));

export const notificationEvents = mysqlTable("notification_events", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  eventKey: varchar("event_key", { length: 255 }).notNull(),
  schemaVersion: int("schema_version").notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  severity: varchar("severity", { length: 32 }).notNull(),
  teamId: int("team_id").notNull(),
  workerNodeId: varchar("worker_node_id", { length: 120 }).notNull(),
  traceId: varchar("trace_id", { length: 160 }),
  subjectType: varchar("subject_type", { length: 64 }).notNull(),
  subjectId: varchar("subject_id", { length: 160 }).notNull(),
  payloadJson: text("payload_json").notNull(),
  receivedAt: datetime("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  eventKeyIdx: uniqueIndex("notification_events_event_key_uidx").on(table.eventKey),
  teamReceivedIdx: index("notification_events_team_received_idx").on(table.teamId, table.receivedAt),
}));

export const notificationOutbox = mysqlTable("notification_outbox", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  eventKey: varchar("event_key", { length: 255 }).notNull(),
  teamId: int("team_id").notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 255 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  severity: varchar("severity", { length: 32 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("queued"),
  attempts: int("attempts").notNull().default(0),
  availableAt: datetime("available_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lockedBy: varchar("locked_by", { length: 120 }),
  lockedUntil: datetime("locked_until"),
  sentAt: datetime("sent_at"),
  lastError: varchar("last_error", { length: 1000 }),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  eventKeyIdx: uniqueIndex("notification_outbox_event_key_uidx").on(table.eventKey),
  statusAvailableIdx: index("notification_outbox_status_available_idx").on(table.status, table.availableAt),
  teamCreatedIdx: index("notification_outbox_team_created_idx").on(table.teamId, table.createdAt),
}));

export const notificationDeliveries = mysqlTable("notification_deliveries", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  outboxId: bigint("outbox_id", { mode: "number", unsigned: true }).notNull(),
  deliveryAttempt: int("delivery_attempt").notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 255 }),
  errorMessage: varchar("error_message", { length: 1000 }),
  startedAt: datetime("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: datetime("finished_at"),
}, (table) => ({
  outboxIdx: index("notification_deliveries_outbox_idx").on(table.outboxId),
}));

export const runtimeNodes = mysqlTable("runtime_nodes", {
  nodeId: varchar("node_id", { length: 120 }).primaryKey(),
  role: varchar("role", { length: 32 }).notNull(),
  hostname: varchar("hostname", { length: 255 }),
  pid: int("pid"),
  version: varchar("version", { length: 120 }),
  lastHeartbeatAt: datetime("last_heartbeat_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  metadataJson: text("metadata_json"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  roleHeartbeatIdx: index("runtime_nodes_role_heartbeat_idx").on(table.role, table.lastHeartbeatAt),
}));

export const teamRuntimeLeases = mysqlTable("team_runtime_leases", {
  teamId: int("team_id").primaryKey(),
  ownerNodeId: varchar("owner_node_id", { length: 120 }).notNull(),
  ownerRole: varchar("owner_role", { length: 32 }).notNull(),
  leaseToken: varchar("lease_token", { length: 80 }).notNull(),
  leaseExpiresAt: datetime("lease_expires_at").notNull(),
  heartbeatAt: datetime("heartbeat_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  status: varchar("status", { length: 32 }).notNull().default("running"),
  lastError: varchar("last_error", { length: 1000 }),
  startedAt: datetime("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  ownerIdx: index("trl_owner_idx").on(table.ownerNodeId),
  expiresIdx: index("trl_expires_idx").on(table.leaseExpiresAt),
}));

export const teamRuntimeDesiredState = mysqlTable("team_runtime_desired_state", {
  teamId: int("team_id").primaryKey(),
  desiredState: varchar("desired_state", { length: 32 }).notNull().default("running"),
  changedByUserId: int("changed_by_user_id"),
  reason: varchar("reason", { length: 1000 }),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appSettings = mysqlTable("app_settings", {
  key: varchar("setting_key", { length: 100 }).primaryKey(),
  value: varchar("setting_value", { length: 4000 }).notNull().default(""),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
