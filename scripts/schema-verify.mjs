#!/usr/bin/env node
// schema-verify.mjs - read-only MySQL schema drift checker for SPX.
//
// This script reads DB connection settings from process.env or root .env,
// queries information_schema, and compares production tables with the current
// application schema contract. It never writes to the database and never prints
// secret values.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { mysqlScriptConnectionConfigFromEnv } from "./lib/mysql-connection-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const EXPECTED_SCHEMA = {
  auto_accept_verification_jobs: {
    columns: {
      team_id: { type: "int", nullable: false },
      trace_id: { type: "varchar(160)", nullable: false },
      job_json: { type: "mediumtext", nullable: false },
      settled_json: { type: "text", nullable: false },
      notifications_json: { type: "mediumtext", nullable: false },
      status: { type: "varchar(16)", nullable: false, defaultIncludes: "pending" },
      response_ready: { type: "int", nullable: false, defaultIncludes: "0" },
      discovery_pending: { type: "int", nullable: false, defaultIncludes: "0" },
      attempt_count: { type: "int", nullable: false, defaultIncludes: "0" },
      next_attempt_at: { type: "bigint", nullable: false },
      lease_token: { type: "varchar(64)", nullable: true },
      lease_until: { type: "bigint", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["team_id", "trace_id"] },
      { name: "aavj_team_due_idx", unique: false, columns: ["team_id", "status", "next_attempt_at"] },
    ],
  },
  teams: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      name: { type: "varchar(100)", nullable: false },
      enabled: { type: "int", nullable: false, defaultIncludes: "1" },
      spx_cookie: { type: "varchar(4000)", nullable: false, defaultIncludes: "" },
      spx_device_id: { type: "varchar(1000)", nullable: false, defaultIncludes: "" },
      line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      auto_accept_success_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      auto_accept_failure_line_group_id: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      spx_email: { type: "varchar(254)", nullable: false, defaultIncludes: "" },
      spx_password: { type: "text", nullable: true },
      spx_auth_status: { type: "varchar(24)", nullable: false, defaultIncludes: "manual" },
      spx_auth_error: { type: "varchar(48)", nullable: true },
      spx_auth_retry_at: { type: "datetime", nullable: true },
      spx_auth_failures: { type: "int", nullable: false, defaultIncludes: "0" },
      spx_session_expires_at: { type: "datetime", nullable: true },
      spx_last_login_at: { type: "datetime", nullable: true },
      spx_auth_epoch: { type: "int", nullable: false, defaultIncludes: "0" },
      spx_auth_lease_token: { type: "varchar(64)", nullable: true },
      spx_auth_lease_until: { type: "datetime", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "teams_enabled_idx", unique: false, columns: ["enabled"] },
      { name: "teams_name_idx", unique: false, columns: ["name"] },
    ],
  },
  spx_booking_history: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      request_id: { type: "bigint unsigned", nullable: false },
      booking_id: { type: "bigint unsigned", nullable: true },
      booking_name: { type: "varchar(255)", nullable: true },
      agency_name: { type: "varchar(255)", nullable: true },
      route: { type: "varchar(255)", nullable: false },
      origin: { type: "varchar(255)", nullable: true },
      destination: { type: "varchar(255)", nullable: true },
      cost_type: { type: "varchar(50)", nullable: true },
      trip_type: { type: "varchar(50)", nullable: true },
      shift_type: { type: "varchar(50)", nullable: true },
      vehicle_type: { type: "varchar(50)", nullable: true },
      standby_datetime: { type: "varchar(50)", nullable: true },
      acceptance_status: { type: "int", nullable: true },
      assignment_status: { type: "int", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "spx_booking_history_team_request_uidx", unique: true, columns: ["team_id", "request_id"] },
      { name: "booking_id_idx", unique: false, columns: ["booking_id"] },
      { name: "created_at_idx", unique: false, columns: ["created_at"] },
      { name: "spx_booking_history_team_created_idx", unique: false, columns: ["team_id", "created_at"] },
    ],
  },
  users: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      username: { type: "varchar(50)", nullable: false },
      password_hash: { type: "varchar(255)", nullable: false },
      role: { type: "varchar(20)", nullable: false, defaultIncludes: "viewer" },
      team_id: { type: "int", nullable: true },
      auth_version: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { unique: true, columns: ["username"] },
      { name: "users_team_id_idx", unique: false, columns: ["team_id"] },
    ],
  },
  audit_logs: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: true },
      actor_user_id: { type: "int", nullable: true },
      actor_team_id: { type: "int", nullable: true },
      target_team_id: { type: "int", nullable: true },
      username: { type: "varchar(50)", nullable: false },
      action: { type: "varchar(100)", nullable: false },
      details: { type: "varchar(1000)", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "audit_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "audit_username_created_at_idx", unique: false, columns: ["username", "created_at"] },
      { name: "audit_action_created_at_idx", unique: false, columns: ["action", "created_at"] },
      { name: "audit_target_team_created_at_idx", unique: false, columns: ["target_team_id", "created_at"] },
    ],
  },
  notify_rules: {
    columns: {
      id: { type: "varchar(255)", nullable: false },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      name: { type: "varchar(128)", nullable: false },
      origins: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      destinations: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      vehicle_types: { type: "varchar(4000)", nullable: false, defaultIncludes: "[]" },
      need: { type: "int", nullable: false, defaultIncludes: "1" },
      enabled: { type: "int", nullable: false, defaultIncludes: "1" },
      fulfilled: { type: "int", nullable: false, defaultIncludes: "0" },
      auto_accept: { type: "int", nullable: false, defaultIncludes: "0" },
      accept_all: { type: "int", nullable: false, defaultIncludes: "0" },
      auto_accepted: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "notify_rules_team_id_idx", unique: false, columns: ["team_id"] },
    ],
  },
  auto_accept_history: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      rule_id: { type: "varchar(255)", nullable: false },
      rule_name: { type: "varchar(128)", nullable: false },
      booking_id: { type: "bigint unsigned", nullable: false },
      request_ids: { type: "varchar(2000)", nullable: false },
      accepted_count: { type: "int", nullable: false, defaultIncludes: "0" },
      origin: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      destination: { type: "varchar(255)", nullable: false, defaultIncludes: "" },
      vehicle_type: { type: "varchar(50)", nullable: false, defaultIncludes: "" },
      status: { type: "varchar(20)", nullable: false, defaultIncludes: "success" },
      error_message: { type: "varchar(1000)", nullable: true },
      failure_reason: { type: "varchar(64)", nullable: true },
      trace_id: { type: "varchar(160)", nullable: true },
      accept_rtt_ms: { type: "int", nullable: true },
      list_age_ms: { type: "int", nullable: true },
      verification_latency_ms: { type: "int", nullable: true },
      verification_status: { type: "varchar(32)", nullable: true },
      verified_at: { type: "datetime", nullable: true },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "aah_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "aah_rule_id_idx", unique: false, columns: ["rule_id"] },
      { name: "aah_status_created_at_idx", unique: false, columns: ["status", "created_at"] },
      { name: "aah_team_created_at_idx", unique: false, columns: ["team_id", "created_at"] },
      { name: "aah_team_status_created_at_idx", unique: false, columns: ["team_id", "status", "created_at"] },
      { name: "aah_team_reason_created_at_idx", unique: false, columns: ["team_id", "failure_reason", "created_at"] },
      { name: "aah_trace_id_idx", unique: false, columns: ["trace_id"] },
    ],
  },
  metrics_snapshots: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      team_id: { type: "int", nullable: false, defaultIncludes: "1" },
      uptime: { type: "int", nullable: false },
      total_requests: { type: "int", nullable: false, defaultIncludes: "0" },
      success_count: { type: "int", nullable: false, defaultIncludes: "0" },
      error_count: { type: "int", nullable: false, defaultIncludes: "0" },
      success_rate: { type: "varchar(10)", nullable: false, defaultIncludes: "0" },
      latency_avg: { type: "int", nullable: false, defaultIncludes: "0" },
      latency_p95: { type: "int", nullable: false, defaultIncludes: "0" },
      latency_p99: { type: "int", nullable: false, defaultIncludes: "0" },
      total_records_seen: { type: "int", nullable: false, defaultIncludes: "0" },
      changes_detected: { type: "int", nullable: false, defaultIncludes: "0" },
      trips_inserted: { type: "int", nullable: false, defaultIncludes: "0" },
      trips_skipped: { type: "int", nullable: false, defaultIncludes: "0" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "metrics_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "metrics_team_created_at_idx", unique: false, columns: ["team_id", "created_at"] },
    ],
  },
  line_bot_sessions: {
    columns: {
      id: { type: "int", nullable: false, extraIncludes: ["auto_increment"] },
      session_key: { type: "varchar(50)", nullable: false, defaultIncludes: "default" },
      auth_token: { type: "varchar(2000)", nullable: false },
      device: { type: "varchar(50)", nullable: false, defaultIncludes: "IOSIPAD" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "lbs_session_key_idx", unique: true, columns: ["session_key"] },
    ],
  },
  line_image_extractions: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      chat_id: { type: "varchar(255)", nullable: false },
      sender_id: { type: "varchar(255)", nullable: false },
      image_path: { type: "varchar(1000)", nullable: false },
      date_text: { type: "varchar(100)", nullable: false },
      trip_number: { type: "varchar(100)", nullable: false, defaultIncludes: "" },
      driver_name: { type: "varchar(500)", nullable: false },
      agency_name: { type: "varchar(100)", nullable: false },
      vehicle_type: { type: "varchar(100)", nullable: false },
      route: { type: "varchar(255)", nullable: false },
      raw_text: { type: "varchar(4000)", nullable: false },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "lie_created_at_idx", unique: false, columns: ["created_at"] },
      { name: "lie_agency_created_at_idx", unique: false, columns: ["agency_name", "created_at"] },
      { name: "lie_trip_number_created_at_idx", unique: false, columns: ["trip_number", "created_at"] },
    ],
  },
  app_settings: {
    columns: {
      setting_key: { type: "varchar(100)", nullable: false },
      setting_value: { type: "varchar(4000)", nullable: false, defaultIncludes: "" },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
      updated_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["setting_key"] },
    ],
  },
  schema_migrations: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      name: { type: "varchar(255)", nullable: false },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "schema_migrations_name_idx", unique: true, columns: ["name"] },
    ],
  },
  jwt_blacklist: {
    columns: {
      jti: { type: "varchar(64)", nullable: false },
      revoked_at: { type: "bigint", nullable: false },
      expires_at: { type: "bigint", nullable: false },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["jti"] },
      { name: "jwt_blacklist_expires_idx", unique: false, columns: ["expires_at"] },
    ],
  },
  realtime_events: {
    columns: {
      id: { type: "bigint unsigned", nullable: false, extraIncludes: ["auto_increment"] },
      event_id: { type: "varchar(255)", nullable: false },
      idempotency_key: { type: "varchar(512)", nullable: true },
      event_type: { type: "varchar(64)", nullable: false },
      payload_version: { type: "int", nullable: false },
      envelope_version: { type: "int", nullable: false },
      scope_kind: { type: "varchar(16)", nullable: false },
      team_id: { type: "int", nullable: true },
      subject_type: { type: "varchar(64)", nullable: true },
      subject_id: { type: "varchar(160)", nullable: true },
      source_service: { type: "varchar(64)", nullable: false },
      source_node_id: { type: "varchar(120)", nullable: false },
      source_role: { type: "varchar(64)", nullable: false },
      trace_id: { type: "varchar(160)", nullable: true },
      replayable: { type: "int", nullable: false, defaultIncludes: "0" },
      payload_json: { type: "text", nullable: false },
      envelope_json: { type: "text", nullable: false },
      emitted_at: { type: "datetime", nullable: false },
      received_at: { type: "datetime", nullable: false },
      created_at: { type: "datetime", nullable: false, defaultIncludes: "current_timestamp" },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "realtime_events_event_id_uidx", unique: true, columns: ["event_id"] },
      { name: "realtime_events_idempotency_key_uidx", unique: true, columns: ["idempotency_key"] },
      { name: "realtime_events_scope_team_id_idx", unique: false, columns: ["scope_kind", "team_id", "id"] },
      { name: "realtime_events_type_received_idx", unique: false, columns: ["event_type", "received_at"] },
      { name: "realtime_events_source_node_received_idx", unique: false, columns: ["source_node_id", "received_at"] },
      { name: "realtime_events_replayable_id_idx", unique: false, columns: ["replayable", "id"] },
      { name: "realtime_events_replay_scope_id_idx", unique: false, columns: ["replayable", "scope_kind", "team_id", "id"] },
      { name: "realtime_events_replay_created_id_idx", unique: false, columns: ["replayable", "created_at", "id"] },
    ],
  },
  realtime_execution_metrics: {
    columns: {
      team_id: { type: "int", nullable: false },
      source_node_id: { type: "varchar(120)", nullable: false },
      generation: { type: "varchar(128)", nullable: false },
      started_at: { type: "datetime(3)", nullable: false },
      snapshot_json: { type: "json", nullable: false },
      emitted_at: { type: "datetime(3)", nullable: false },
      received_at: { type: "datetime(3)", nullable: false },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["team_id", "source_node_id"] },
      { name: "realtime_execution_metrics_received_idx", unique: false, columns: ["received_at"] },
    ],
  },
  realtime_metrics_read_models: {
    columns: {
      team_id: { type: "int", nullable: false },
      source_node_id: { type: "varchar(120)", nullable: false },
      snapshot_json: { type: "json", nullable: false },
      emitted_at: { type: "datetime(3)", nullable: false },
      received_at: { type: "datetime(3)", nullable: false },
      updated_at: { type: "datetime(3)", nullable: false, defaultIncludes: "current_timestamp", extraIncludes: ["on update"] },
    },
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["team_id"] },
      { name: "realtime_metrics_read_models_received_team_idx", unique: false, columns: ["received_at", "team_id"] },
    ],
  },
  "internal_request_replays": {
    "columns": {
      "replay_key": {
        "type": "char(64)",
        "nullable": false
      },
      "partition_name": {
        "type": "varchar(64)",
        "nullable": false
      },
      "expires_at": {
        "type": "datetime(3)",
        "nullable": false
      },
      "created_at": {
        "type": "datetime(3)",
        "nullable": false,
        "defaultIncludes": "current_timestamp(3)"
      }
    },
    "indexes": [
      {
        "name": "PRIMARY",
        "unique": true,
        "columns": [
          "replay_key"
        ]
      },
      {
        "name": "internal_request_replays_partition_expires_idx",
        "unique": false,
        "columns": [
          "partition_name",
          "expires_at"
        ]
      },
      {
        "name": "internal_request_replays_expires_idx",
        "unique": false,
        "columns": [
          "expires_at"
        ]
      }
    ]
  },
  "notification_provider_reconciliations": {
    "columns": {
      "id": {
        "type": "bigint unsigned",
        "nullable": false,
        "extraIncludes": [
          "auto_increment"
        ]
      },
      "outbox_id": {
        "type": "bigint unsigned",
        "nullable": false
      },
      "provider_request_id": {
        "type": "varchar(128)",
        "nullable": false
      },
      "provider_started_at": {
        "type": "datetime",
        "nullable": false
      },
      "expected_status": {
        "type": "varchar(32)",
        "nullable": false
      },
      "action": {
        "type": "varchar(32)",
        "nullable": false
      },
      "result_status": {
        "type": "varchar(32)",
        "nullable": false
      },
      "actor_user_id": {
        "type": "int",
        "nullable": false
      },
      "actor_username": {
        "type": "varchar(50)",
        "nullable": false
      },
      "actor_team_id": {
        "type": "int",
        "nullable": true
      },
      "target_team_id": {
        "type": "int",
        "nullable": false
      },
      "evidence_reference": {
        "type": "varchar(255)",
        "nullable": false
      },
      "reason": {
        "type": "varchar(500)",
        "nullable": false
      },
      "provider_message_id": {
        "type": "varchar(255)",
        "nullable": true
      },
      "created_at": {
        "type": "datetime",
        "nullable": false,
        "defaultIncludes": "current_timestamp"
      }
    },
    "indexes": [
      {
        "name": "PRIMARY",
        "unique": true,
        "columns": [
          "id"
        ]
      },
      {
        "name": "npr_outbox_provider_fence_uidx",
        "unique": true,
        "columns": [
          "outbox_id",
          "provider_request_id",
          "provider_started_at"
        ]
      }
    ]
  },
  "notification_outbox": {
    "columns": {
      "id": {
        "type": "bigint unsigned",
        "nullable": false,
        "extraIncludes": [
          "auto_increment"
        ]
      },
      "event_key": {
        "type": "varchar(255)",
        "nullable": false
      },
      "team_id": {
        "type": "int",
        "nullable": false
      },
      "target_type": {
        "type": "varchar(32)",
        "nullable": false
      },
      "target_id": {
        "type": "varchar(255)",
        "nullable": false
      },
      "event_type": {
        "type": "varchar(64)",
        "nullable": false
      },
      "severity": {
        "type": "varchar(32)",
        "nullable": false
      },
      "title": {
        "type": "varchar(255)",
        "nullable": false
      },
      "message": {
        "type": "text",
        "nullable": false
      },
      "payload_json": {
        "type": "text",
        "nullable": false
      },
      "status": {
        "type": "varchar(32)",
        "nullable": false,
        "defaultIncludes": "queued"
      },
      "attempts": {
        "type": "int",
        "nullable": false,
        "defaultIncludes": "0"
      },
      "available_at": {
        "type": "datetime",
        "nullable": false,
        "defaultIncludes": "current_timestamp"
      },
      "locked_by": {
        "type": "varchar(120)",
        "nullable": true
      },
      "locked_until": {
        "type": "datetime",
        "nullable": true
      },
      "provider_request_id": {
        "type": "varchar(128)",
        "nullable": true
      },
      "provider_started_at": {
        "type": "datetime",
        "nullable": true
      },
      "provider_execution_started_at": {
        "type": "datetime",
        "nullable": true
      },
      "sent_at": {
        "type": "datetime",
        "nullable": true
      },
      "last_error": {
        "type": "varchar(1000)",
        "nullable": true
      },
      "created_at": {
        "type": "datetime",
        "nullable": false,
        "defaultIncludes": "current_timestamp"
      },
      "updated_at": {
        "type": "datetime",
        "nullable": false,
        "defaultIncludes": "current_timestamp"
      }
    },
    "indexes": [
      {
        "name": "PRIMARY",
        "unique": true,
        "columns": [
          "id"
        ]
      },
      {
        "name": "notification_outbox_event_key_uidx",
        "unique": true,
        "columns": [
          "event_key"
        ]
      },
      {
        "name": "notification_outbox_status_available_idx",
        "unique": false,
        "columns": [
          "status",
          "available_at"
        ]
      },
      {
        "name": "notification_outbox_team_created_idx",
        "unique": false,
        "columns": [
          "team_id",
          "created_at"
        ]
      }
    ]
  },
};

const APP_TABLE_PREFIXES = ["spx_", "line_", "auto_", "metrics_", "realtime_"];
const APP_TABLE_NAMES = new Set([
  "teams",
  "users",
  "audit_logs",
  "notify_rules",
  "app_settings",
  "schema_migrations",
  "jwt_blacklist",
  "internal_request_replays",
  "notification_provider_reconciliations",
  "notification_outbox",
]);

function isAppOwnedTable(tableName) {
  return APP_TABLE_NAMES.has(tableName) || APP_TABLE_PREFIXES.some((prefix) => tableName.startsWith(prefix));
}

function loadDotEnv() {
  const envFilePath = resolve(ROOT, ".env");
  if (!existsSync(envFilePath)) return;
  const lines = readFileSync(envFilePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function getDbConfig() {
  loadDotEnv();
  const resolved = mysqlScriptConnectionConfigFromEnv(process.env);
  if (resolved.missing.length > 0) {
    const missing = resolved.missing.join(", ");
    throw new Error(`Missing DB env values: ${missing}`);
  }
  if (process.env.DB_MODE === "memory") {
    throw new Error("DB_MODE=memory cannot verify a MySQL production schema");
  }
  return {
    ...resolved.value,
    charset: "utf8mb4",
    timezone: "+00:00",
    dateStrings: true,
  };
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[()]/g, "").trim();
}

function defaultsMatch(actualDefault, expectedIncludes) {
  if (expectedIncludes === undefined) return true;
  const actual = normalize(actualDefault);
  const expected = normalize(expectedIncludes);
  if (expected === "") return actual === "";
  return actual.includes(expected);
}

function columnsEqual(actualColumns, expectedColumns, tableName, problems) {
  const actualByName = new Map(actualColumns.map((column) => [column.column_name, column]));

  for (const [columnName, expected] of Object.entries(expectedColumns)) {
    const actual = actualByName.get(columnName);
    if (!actual) {
      problems.push(`${tableName}.${columnName}: missing column`);
      continue;
    }

    if (normalize(actual.column_type) !== normalize(expected.type)) {
      problems.push(`${tableName}.${columnName}: type ${actual.column_type} != ${expected.type}`);
    }

    const actualNullable = actual.is_nullable === "YES";
    if (actualNullable !== expected.nullable) {
      problems.push(`${tableName}.${columnName}: nullable ${actual.is_nullable} != ${expected.nullable ? "YES" : "NO"}`);
    }

    if (!defaultsMatch(actual.column_default, expected.defaultIncludes)) {
      problems.push(`${tableName}.${columnName}: default ${actual.column_default ?? "NULL"} does not include ${expected.defaultIncludes}`);
    }

    for (const needle of expected.extraIncludes ?? []) {
      if (!normalize(actual.extra).includes(normalize(needle))) {
        problems.push(`${tableName}.${columnName}: extra ${actual.extra || "(empty)"} missing ${needle}`);
      }
    }
  }

  for (const actual of actualColumns) {
    if (!expectedColumns[actual.column_name]) {
      problems.push(`${tableName}.${actual.column_name}: extra column not in source contract`);
    }
  }
}

function groupIndexes(indexRows) {
  const byName = new Map();
  for (const row of indexRows) {
    const key = row.index_name;
    if (!byName.has(key)) {
      byName.set(key, {
        name: row.index_name,
        unique: Number(row.non_unique) === 0,
        columns: [],
      });
    }
    byName.get(key).columns.push(row.column_name);
  }
  return [...byName.values()];
}

function indexesEqual(actualIndexes, expectedIndexes, tableName, problems) {
  for (const expected of expectedIndexes) {
    const match = actualIndexes.find((actual) => {
      if (expected.name && actual.name !== expected.name) return false;
      if (actual.unique !== expected.unique) return false;
      return actual.columns.join(",") === expected.columns.join(",");
    });

    if (!match) {
      const name = expected.name ? `${expected.name} ` : "";
      problems.push(`${tableName}: missing ${expected.unique ? "unique " : ""}index ${name}(${expected.columns.join(", ")})`);
    }
  }
}

async function main() {
  const dbConfig = getDbConfig();
  const expectedTables = Object.keys(EXPECTED_SCHEMA);
  const connection = await mysql.createConnection(dbConfig);

  try {
    const [allTableRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         engine AS engine,
         table_collation AS table_collation
       FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_name`,
      [dbConfig.database],
    );
    const tableRows = allTableRows.filter((row) => expectedTables.includes(row.table_name));

    const [columnRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         column_name AS column_name,
         column_type AS column_type,
         is_nullable AS is_nullable,
         column_default AS column_default,
         extra AS extra
       FROM information_schema.columns
       WHERE table_schema = ?
         AND table_name IN (${expectedTables.map(() => "?").join(",")})
       ORDER BY table_name, ordinal_position`,
      [dbConfig.database, ...expectedTables],
    );

    const [indexRows] = await connection.execute(
      `SELECT
         table_name AS table_name,
         index_name AS index_name,
         non_unique AS non_unique,
         seq_in_index AS seq_in_index,
         column_name AS column_name
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name IN (${expectedTables.map(() => "?").join(",")})
       ORDER BY table_name, index_name, seq_in_index`,
      [dbConfig.database, ...expectedTables],
    );

    const tableNames = new Set(tableRows.map((row) => row.table_name));
    const columnsByTable = new Map();
    for (const row of columnRows) {
      if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, []);
      columnsByTable.get(row.table_name).push(row);
    }

    const indexesByTable = new Map();
    for (const row of indexRows) {
      if (!indexesByTable.has(row.table_name)) indexesByTable.set(row.table_name, []);
      indexesByTable.get(row.table_name).push(row);
    }

    const problems = [];
    for (const [tableName, expected] of Object.entries(EXPECTED_SCHEMA)) {
      if (!tableNames.has(tableName)) {
        problems.push(`${tableName}: missing table`);
        continue;
      }
      columnsEqual(columnsByTable.get(tableName) ?? [], expected.columns, tableName, problems);
      indexesEqual(groupIndexes(indexesByTable.get(tableName) ?? []), expected.indexes, tableName, problems);
    }

    const observedExtraTables = allTableRows
      .map((row) => row.table_name)
      .filter((name) => isAppOwnedTable(name))
      .filter((name) => !EXPECTED_SCHEMA[name]);

    console.log("");
    console.log("SPX Schema Verification (read-only)");
    console.log(`Database: ${dbConfig.database}`);
    console.log(`Expected tables: ${expectedTables.length}`);
    console.log(`Observed expected tables: ${tableRows.length}`);
    console.log("-".repeat(60));

    for (const row of tableRows) {
      const columnCount = (columnsByTable.get(row.table_name) ?? []).length;
      const indexCount = groupIndexes(indexesByTable.get(row.table_name) ?? []).length;
      console.log(`${row.table_name}: ${columnCount} columns, ${indexCount} indexes, ${row.engine || "unknown"} / ${row.table_collation || "unknown"}`);
    }

    if (observedExtraTables.length > 0) {
      console.log("");
      console.log(`Extra matched tables ignored: ${observedExtraTables.join(", ")}`);
    }

    if (problems.length > 0) {
      console.log("");
      console.log(`Schema drift detected (${problems.length}):`);
      for (const problem of problems) console.log(`  - ${problem}`);
      process.exit(2);
    }

    console.log("");
    console.log("Result: schema matches the source contract.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
