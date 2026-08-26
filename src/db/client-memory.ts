// @ts-nocheck
/**
 * SQLite in-memory database client for testing
 * Uses better-sqlite3 with Drizzle ORM
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";

let sqliteDb: Database.Database | null = null;
let drizzleDb: ReturnType<typeof drizzle> | null = null;

/**
 * Get or create SQLite in-memory database
 * Returns a Drizzle ORM instance compatible with MySQL schema
 */
export function getMemoryDb(): ReturnType<typeof drizzle> {
  if (drizzleDb) {
    return drizzleDb;
  }

  sqliteDb = new Database(":memory:");
  drizzleDb = drizzle(sqliteDb, { schema });

  // Initialize schema
  initSchema(sqliteDb);

  return drizzleDb;
}

/**
 * Close the in-memory database
 */
export function closeMemoryDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    drizzleDb = null;
  }
}

/**
 * Reset all data in the in-memory database
 */
export function resetMemoryDb(): void {
  closeMemoryDb();
  getMemoryDb();
}

/**
 * Initialize SQLite schema (tables)
 */
function initSchema(db: Database.Database): void {
  // Create tables that mirror MySQL schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      spx_cookie TEXT NOT NULL DEFAULT '',
      spx_device_id TEXT NOT NULL DEFAULT '',
      line_group_id TEXT NOT NULL DEFAULT '',
      auto_accept_success_line_group_id TEXT NOT NULL DEFAULT '',
      auto_accept_failure_line_group_id TEXT NOT NULL DEFAULT '',
      rate_limit_notify_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS teams_enabled_idx ON teams(enabled);
    CREATE INDEX IF NOT EXISTS teams_name_idx ON teams(name);

    CREATE TABLE IF NOT EXISTS spx_booking_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
      request_id INTEGER NOT NULL,
      booking_id INTEGER,
      booking_name TEXT,
      agency_name TEXT,
      route TEXT NOT NULL,
      origin TEXT,
      destination TEXT,
      cost_type TEXT,
      trip_type TEXT,
      shift_type TEXT,
      vehicle_type TEXT,
      standby_datetime TEXT,
      acceptance_status INTEGER,
      assignment_status INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS spx_booking_history_team_request_uidx ON spx_booking_history(team_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_booking_id ON spx_booking_history(booking_id);
    CREATE INDEX IF NOT EXISTS idx_created_at ON spx_booking_history(created_at);
    CREATE INDEX IF NOT EXISTS spx_booking_history_team_created_idx ON spx_booking_history(team_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      team_id INTEGER,
      auth_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS users_team_id_idx ON users(team_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER,
      actor_user_id INTEGER,
      actor_team_id INTEGER,
      target_team_id INTEGER,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS audit_username_created_at_idx ON audit_logs(username, created_at);
    CREATE INDEX IF NOT EXISTS audit_action_created_at_idx ON audit_logs(action, created_at);
    CREATE INDEX IF NOT EXISTS audit_target_team_created_at_idx ON audit_logs(target_team_id, created_at);

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
      uptime INTEGER NOT NULL,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      success_rate TEXT NOT NULL DEFAULT '0',
      latency_avg INTEGER NOT NULL DEFAULT 0,
      latency_p95 INTEGER NOT NULL DEFAULT 0,
      latency_p99 INTEGER NOT NULL DEFAULT 0,
      total_records_seen INTEGER NOT NULL DEFAULT 0,
      changes_detected INTEGER NOT NULL DEFAULT 0,
      trips_inserted INTEGER NOT NULL DEFAULT 0,
      trips_skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS metrics_team_created_at_idx ON metrics_snapshots(team_id, created_at);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notify_rules (
      id TEXT NOT NULL PRIMARY KEY,
      team_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      origins TEXT NOT NULL DEFAULT '[]',
      destinations TEXT NOT NULL DEFAULT '[]',
      vehicle_types TEXT NOT NULL DEFAULT '[]',
      need INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      fulfilled INTEGER NOT NULL DEFAULT 0,
      auto_accept INTEGER NOT NULL DEFAULT 0,
      accept_all INTEGER NOT NULL DEFAULT 0,
      auto_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS notify_rules_team_id_idx ON notify_rules(team_id);

    CREATE TABLE IF NOT EXISTS auto_accept_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL DEFAULT 1,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      booking_id INTEGER NOT NULL,
      request_ids TEXT NOT NULL,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT '',
      destination TEXT NOT NULL DEFAULT '',
      vehicle_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      failure_reason TEXT,
      trace_id TEXT,
      accept_rtt_ms INTEGER,
      list_age_ms INTEGER,
      verification_latency_ms INTEGER,
      verification_status TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS aah_created_at_idx ON auto_accept_history(created_at);
    CREATE INDEX IF NOT EXISTS aah_rule_id_idx ON auto_accept_history(rule_id);
    CREATE INDEX IF NOT EXISTS aah_status_created_at_idx ON auto_accept_history(status, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_created_at_idx ON auto_accept_history(team_id, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_status_created_at_idx ON auto_accept_history(team_id, status, created_at);
    CREATE INDEX IF NOT EXISTS aah_team_reason_created_at_idx ON auto_accept_history(team_id, failure_reason, created_at);
    CREATE INDEX IF NOT EXISTS aah_trace_id_idx ON auto_accept_history(trace_id);

    CREATE TABLE IF NOT EXISTS line_bot_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL DEFAULT 'default',
      auth_token TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT 'IOSIPAD',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_bot_sessions_key ON line_bot_sessions(session_key);

    CREATE TABLE IF NOT EXISTS line_image_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      image_path TEXT NOT NULL,
      date_text TEXT NOT NULL,
      trip_number TEXT NOT NULL DEFAULT '',
      driver_name TEXT NOT NULL,
      agency_name TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      route TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS lie_created_at_idx ON line_image_extractions(created_at);
    CREATE INDEX IF NOT EXISTS lie_agency_created_at_idx ON line_image_extractions(agency_name, created_at);
    CREATE INDEX IF NOT EXISTS lie_trip_number_created_at_idx ON line_image_extractions(trip_number, created_at);

    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      worker_node_id TEXT NOT NULL,
      trace_id TEXT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS notification_events_event_key_uidx ON notification_events(event_key);
    CREATE INDEX IF NOT EXISTS notification_events_team_received_idx ON notification_events(team_id, received_at);

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT (datetime('now')),
      locked_by TEXT,
      locked_until TEXT,
      provider_request_id TEXT,
      provider_started_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_event_key_uidx ON notification_outbox(event_key);
    CREATE INDEX IF NOT EXISTS notification_outbox_status_available_idx ON notification_outbox(status, available_at);
    CREATE INDEX IF NOT EXISTS notification_outbox_team_created_idx ON notification_outbox(team_id, created_at);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id INTEGER NOT NULL,
      delivery_attempt INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS notification_deliveries_outbox_idx ON notification_deliveries(outbox_id);

    CREATE TABLE IF NOT EXISTS runtime_nodes (
      node_id TEXT NOT NULL PRIMARY KEY,
      role TEXT NOT NULL,
      hostname TEXT,
      pid INTEGER,
      version TEXT,
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS runtime_nodes_role_heartbeat_idx ON runtime_nodes(role, last_heartbeat_at);

    CREATE TABLE IF NOT EXISTS team_runtime_leases (
      team_id INTEGER NOT NULL PRIMARY KEY,
      owner_node_id TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'running',
      last_error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS trl_owner_idx ON team_runtime_leases(owner_node_id);
    CREATE INDEX IF NOT EXISTS trl_expires_idx ON team_runtime_leases(lease_expires_at);

    CREATE TABLE IF NOT EXISTS team_runtime_desired_state (
      team_id INTEGER NOT NULL PRIMARY KEY,
      desired_state TEXT NOT NULL DEFAULT 'running',
      changed_by_user_id INTEGER,
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_accept_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      worker_node_id TEXT NOT NULL,
      booking_id INTEGER NOT NULL,
      request_ids_json TEXT NOT NULL,
      rule_id TEXT,
      rule_name TEXT,
      accept_mode TEXT NOT NULL,
      accept_started_at TEXT NOT NULL,
      accept_finished_at TEXT,
      accept_rtt_ms INTEGER,
      spx_http_status INTEGER,
      spx_retcode INTEGER,
      spx_message TEXT,
      raw_error TEXT,
      ambiguous_accept INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aaa_trace_uidx ON auto_accept_attempts(trace_id);
    CREATE INDEX IF NOT EXISTS aaa_team_booking_idx ON auto_accept_attempts(team_id, booking_id);
    CREATE INDEX IF NOT EXISTS aaa_worker_created_idx ON auto_accept_attempts(worker_node_id, created_at);

    CREATE TABLE IF NOT EXISTS auto_accept_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      winning_attempt_trace_id TEXT,
      status TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      evidence_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aar_team_booking_request_uidx ON auto_accept_results(team_id, booking_id, request_id);
    CREATE INDEX IF NOT EXISTS aar_team_status_idx ON auto_accept_results(team_id, status);
    CREATE INDEX IF NOT EXISTS aar_trace_idx ON auto_accept_results(winning_attempt_trace_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT NOT NULL PRIMARY KEY,
      setting_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_accept_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      team_id INTEGER NOT NULL,
      cutover_epoch TEXT,
      publication_generation INTEGER,
      booking_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      rule_id TEXT NOT NULL,
      attempt_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      claim_owner TEXT,
      claim_token TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      last_heartbeat_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      verify_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      last_reason_code TEXT,
      winning_attempt_trace_id TEXT,
      result_status TEXT,
      result_reason_code TEXT,
      progress_settled_at TEXT,
      history_written_at TEXT,
      notification_enqueued_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aaj_idempotency_key_uidx ON auto_accept_jobs(idempotency_key);
    CREATE INDEX IF NOT EXISTS aaj_claimable_idx ON auto_accept_jobs(status, next_run_at, claim_expires_at);
    CREATE INDEX IF NOT EXISTS aaj_team_status_idx ON auto_accept_jobs(team_id, status);
    CREATE INDEX IF NOT EXISTS aaj_claim_owner_idx ON auto_accept_jobs(claim_owner, claim_expires_at);
    CREATE INDEX IF NOT EXISTS aaj_result_trace_idx ON auto_accept_jobs(winning_attempt_trace_id);
    CREATE INDEX IF NOT EXISTS aaj_team_epoch_generation_status_idx ON auto_accept_jobs(team_id, cutover_epoch, publication_generation, status);

    CREATE TABLE IF NOT EXISTS realtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      idempotency_key TEXT,
      event_type TEXT NOT NULL,
      payload_version INTEGER NOT NULL,
      envelope_version INTEGER NOT NULL,
      scope_kind TEXT NOT NULL,
      team_id INTEGER,
      subject_type TEXT,
      subject_id TEXT,
      source_service TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      source_role TEXT NOT NULL,
      trace_id TEXT,
      replayable INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      emitted_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS realtime_events_event_id_uidx ON realtime_events(event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS realtime_events_idempotency_key_uidx ON realtime_events(idempotency_key);
    CREATE INDEX IF NOT EXISTS realtime_events_scope_team_id_idx ON realtime_events(scope_kind, team_id, id);
    CREATE INDEX IF NOT EXISTS realtime_events_type_received_idx ON realtime_events(event_type, received_at);
    CREATE INDEX IF NOT EXISTS realtime_events_source_node_received_idx ON realtime_events(source_node_id, received_at);
    CREATE INDEX IF NOT EXISTS realtime_events_replayable_id_idx ON realtime_events(replayable, id);
    CREATE INDEX IF NOT EXISTS realtime_events_replay_scope_id_idx ON realtime_events(replayable, scope_kind, team_id, id);
    CREATE INDEX IF NOT EXISTS realtime_events_replay_created_id_idx ON realtime_events(replayable, created_at, id);

    CREATE TABLE IF NOT EXISTS auto_accept_job_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_key TEXT NOT NULL,
      job_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      rule_id TEXT NOT NULL,
      settlement_step TEXT NOT NULL,
      side_effect_id INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aajs_settlement_key_uidx ON auto_accept_job_settlements(settlement_key);
    CREATE UNIQUE INDEX IF NOT EXISTS aajs_job_step_uidx ON auto_accept_job_settlements(job_id, settlement_step);
    CREATE INDEX IF NOT EXISTS aajs_team_step_completed_idx ON auto_accept_job_settlements(team_id, settlement_step, completed_at);

    CREATE TABLE IF NOT EXISTS realtime_metrics_read_models (
      team_id INTEGER NOT NULL PRIMARY KEY,
      source_node_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      emitted_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS realtime_metrics_read_models_received_team_idx ON realtime_metrics_read_models(received_at, team_id);

    CREATE TABLE IF NOT EXISTS internal_request_replays (
      replay_key TEXT NOT NULL PRIMARY KEY,
      partition_name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS internal_request_replays_partition_expires_idx ON internal_request_replays(partition_name, expires_at);
    CREATE INDEX IF NOT EXISTS internal_request_replays_expires_idx ON internal_request_replays(expires_at);

    CREATE TABLE IF NOT EXISTS auto_accept_publication_controls (
      team_id INTEGER NOT NULL,
      cutover_epoch TEXT NOT NULL,
      publication_generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      poller_node_id TEXT NOT NULL,
      fence_job_id INTEGER,
      fence_requested_at TEXT,
      ack_node_id TEXT,
      ack_job_id INTEGER,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, cutover_epoch)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aapc_team_generation_uq ON auto_accept_publication_controls(team_id, publication_generation);
    CREATE UNIQUE INDEX IF NOT EXISTS aapc_team_epoch_generation_uq ON auto_accept_publication_controls(team_id, cutover_epoch, publication_generation);
    CREATE INDEX IF NOT EXISTS aapc_state_updated_idx ON auto_accept_publication_controls(state, updated_at);

    CREATE TABLE IF NOT EXISTS auto_accept_publication_active_epochs (
      team_id INTEGER NOT NULL PRIMARY KEY,
      active_epoch TEXT NOT NULL,
      active_generation INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS aapa_team_generation_uq ON auto_accept_publication_active_epochs(team_id, active_generation);

    CREATE TABLE IF NOT EXISTS gate6_environment_slots (
      environment TEXT NOT NULL PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      transfer_token_sha256 TEXT,
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      uncompensated_work INTEGER NOT NULL DEFAULT 0,
      protected_install_evidence_sha256 TEXT NOT NULL,
      release_sha TEXT NOT NULL,
      target_descriptor_sha256 TEXT NOT NULL,
      operator_bundle_sha256 TEXT NOT NULL,
      installed_migration_set_sha256 TEXT NOT NULL,
      installed_schema_version INTEGER NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS gate6_slot_owner_uq ON gate6_environment_slots(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS gate6_slot_state_expiry_idx ON gate6_environment_slots(state, expires_at);

    CREATE TABLE IF NOT EXISTS gate6_runs (
      gate6_id TEXT NOT NULL PRIMARY KEY,
      gate6_nonce TEXT NOT NULL,
      envelope_sha256 TEXT NOT NULL,
      envelope_core_sha256 TEXT NOT NULL,
      release_environment TEXT NOT NULL,
      runtime_environment TEXT NOT NULL,
      drill_mode TEXT NOT NULL,
      compose_project TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      candidate_image_digest TEXT NOT NULL,
      rollback_sha TEXT NOT NULL,
      rollback_image_digest TEXT NOT NULL,
      production_target_descriptor_sha256 TEXT NOT NULL,
      operator_bundle_sha256 TEXT NOT NULL,
      protected_install_evidence_sha256 TEXT NOT NULL,
      installed_migration_set_sha256 TEXT NOT NULL,
      installed_schema_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      stage_version INTEGER NOT NULL DEFAULT 1,
      accepted_checker_name TEXT,
      accepted_checker_sha256 TEXT,
      revocation_reason_code TEXT,
      monitor_status TEXT NOT NULL,
      monitor_lease_expires_at TEXT NOT NULL,
      supervisor_status TEXT NOT NULL,
      supervisor_lease_expires_at TEXT NOT NULL,
      emergency_supervisor_lease_expires_at TEXT NOT NULL,
      terminal_evidence_sha256 TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS gate6_runs_envelope_uq ON gate6_runs(envelope_sha256);
    CREATE UNIQUE INDEX IF NOT EXISTS gate6_runs_nonce_uq ON gate6_runs(gate6_nonce);
    CREATE INDEX IF NOT EXISTS gate6_runs_status_expiry_idx ON gate6_runs(status, expires_at);

    CREATE TABLE IF NOT EXISTS gate6_actions (
      gate6_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      action_id TEXT NOT NULL,
      approval_sha256 TEXT NOT NULL,
      allowed_mutation_sha256 TEXT NOT NULL,
      kind TEXT NOT NULL,
      paired_action_id TEXT,
      predecessor_action_ids_json TEXT NOT NULL,
      required_stage TEXT NOT NULL,
      required_checker_sha256 TEXT,
      status TEXT NOT NULL,
      before_evidence_sha256 TEXT,
      after_evidence_sha256 TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (gate6_id, scope, action_id),
      FOREIGN KEY (gate6_id) REFERENCES gate6_runs (gate6_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS gate6_actions_id_uq ON gate6_actions(gate6_id, action_id);
    CREATE INDEX IF NOT EXISTS gate6_actions_status_expiry_idx ON gate6_actions(gate6_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS gate6_fault_permits (
      permit_id TEXT NOT NULL PRIMARY KEY,
      gate6_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      action_id TEXT NOT NULL,
      service TEXT NOT NULL,
      kind TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      drill_sha256 TEXT NOT NULL,
      target_sha256 TEXT,
      fixture_sha256 TEXT,
      signed_permit_sha256 TEXT NOT NULL,
      verification_key_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      disarmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (gate6_id, scope, action_id) REFERENCES gate6_actions (gate6_id, scope, action_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS gate6_permit_action_uq ON gate6_fault_permits(gate6_id, scope, action_id);
    CREATE INDEX IF NOT EXISTS gate6_permit_status_expiry_idx ON gate6_fault_permits(gate6_id, status, expires_at);

    CREATE VIEW IF NOT EXISTS operational_gate6_terminal_evidence AS
    SELECT
      r.gate6_id,
      r.candidate_sha,
      r.candidate_image_digest,
      r.rollback_sha,
      r.rollback_image_digest,
      r.production_target_descriptor_sha256,
      r.operator_bundle_sha256,
      r.installed_migration_set_sha256,
      r.installed_schema_version,
      r.status AS run_status,
      r.current_stage,
      r.stage_version,
      r.accepted_checker_name,
      r.accepted_checker_sha256,
      s.owner_type AS slot_owner_type,
      s.owner_id AS slot_owner_id,
      s.state AS slot_state,
      s.uncompensated_work,
      COALESCE(a.forward_registered_count, 0) AS forward_registered_count,
      COALESCE(a.forward_consumed_count, 0) AS forward_consumed_count,
      COALESCE(a.forward_succeeded_count, 0) AS forward_succeeded_count,
      COALESCE(a.forward_failed_count, 0) AS forward_failed_count,
      COALESCE(a.forward_ambiguous_count, 0) AS forward_ambiguous_count,
      COALESCE(a.forward_compensated_count, 0) AS forward_compensated_count,
      COALESCE(a.compensation_registered_count, 0) AS compensation_registered_count,
      COALESCE(a.compensation_consumed_count, 0) AS compensation_consumed_count,
      COALESCE(a.compensation_succeeded_count, 0) AS compensation_succeeded_count,
      COALESCE(a.compensation_failed_count, 0) AS compensation_failed_count,
      COALESCE(a.compensation_ambiguous_count, 0) AS compensation_ambiguous_count,
      COALESCE(a.compensation_compensated_count, 0) AS compensation_compensated_count,
      COALESCE(a.compensation_not_needed_count, 0) AS compensation_not_needed_count,
      COALESCE(a.emergency_registered_count, 0) AS emergency_registered_count,
      COALESCE(a.emergency_consumed_count, 0) AS emergency_consumed_count,
      COALESCE(a.emergency_succeeded_count, 0) AS emergency_succeeded_count,
      COALESCE(a.emergency_failed_count, 0) AS emergency_failed_count,
      COALESCE(a.emergency_ambiguous_count, 0) AS emergency_ambiguous_count,
      COALESCE(p.active_permit_count, 0) AS active_permit_count,
      r.terminal_evidence_sha256,
      r.created_at,
      r.updated_at
    FROM gate6_runs r
    JOIN gate6_environment_slots s
      ON s.environment = 'production' AND s.owner_type = 'gate6' AND s.owner_id = r.gate6_id
    LEFT JOIN (
      SELECT
        gate6_id,
        SUM(kind = 'forward' AND status = 'registered') AS forward_registered_count,
        SUM(kind = 'forward' AND status = 'consumed') AS forward_consumed_count,
        SUM(kind = 'forward' AND status = 'succeeded') AS forward_succeeded_count,
        SUM(kind = 'forward' AND status = 'failed') AS forward_failed_count,
        SUM(kind = 'forward' AND status = 'ambiguous') AS forward_ambiguous_count,
        SUM(kind = 'forward' AND status = 'compensated') AS forward_compensated_count,
        SUM(kind = 'compensation' AND status = 'registered') AS compensation_registered_count,
        SUM(kind = 'compensation' AND status = 'consumed') AS compensation_consumed_count,
        SUM(kind = 'compensation' AND status = 'succeeded') AS compensation_succeeded_count,
        SUM(kind = 'compensation' AND status = 'failed') AS compensation_failed_count,
        SUM(kind = 'compensation' AND status = 'ambiguous') AS compensation_ambiguous_count,
        SUM(kind = 'compensation' AND status = 'compensated') AS compensation_compensated_count,
        SUM(kind = 'compensation' AND status = 'not_needed') AS compensation_not_needed_count,
        SUM(kind = 'emergency' AND status = 'registered') AS emergency_registered_count,
        SUM(kind = 'emergency' AND status = 'consumed') AS emergency_consumed_count,
        SUM(kind = 'emergency' AND status = 'succeeded') AS emergency_succeeded_count,
        SUM(kind = 'emergency' AND status = 'failed') AS emergency_failed_count,
        SUM(kind = 'emergency' AND status = 'ambiguous') AS emergency_ambiguous_count
      FROM gate6_actions
      GROUP BY gate6_id
    ) a ON a.gate6_id = r.gate6_id
    LEFT JOIN (
      SELECT gate6_id, SUM(status = 'armed') AS active_permit_count
      FROM gate6_fault_permits
      GROUP BY gate6_id
    ) p ON p.gate6_id = r.gate6_id;

    CREATE TABLE IF NOT EXISTS spx_n_minus_one_probe_fixtures (
      probe_role TEXT NOT NULL PRIMARY KEY,
      probe_value INTEGER NOT NULL,
      CHECK (
        probe_role IN (
          'web-api',
          'notification-service',
          'line-service',
          'worker-ifn-split',
          'worker-ptwl-split'
        )
      )
    );

    INSERT OR IGNORE INTO spx_n_minus_one_probe_fixtures (probe_role, probe_value)
    VALUES
      ('web-api', 4101),
      ('notification-service', 4102),
      ('line-service', 4103),
      ('worker-ifn-split', 4104),
      ('worker-ptwl-split', 4105);
  `);
}

/**
 * Get raw SQLite database instance (for migrations)
 */
export function getRawMemoryDb(): Database.Database {
  if (!sqliteDb) {
    getMemoryDb();
  }
  return sqliteDb!;
}

// Legacy exports for compatibility
export function getMemoryPool(): Database.Database {
  return getRawMemoryDb();
}

export function closeMemoryPool(): void {
  closeMemoryDb();
}

export function resetMemoryStore(): void {
  resetMemoryDb();
}
