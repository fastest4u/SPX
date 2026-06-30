export const teamsMigrationSql = `
CREATE TABLE IF NOT EXISTS teams (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  spx_cookie VARCHAR(4000) NOT NULL DEFAULT '',
  spx_device_id VARCHAR(1000) NOT NULL DEFAULT '',
  line_group_id VARCHAR(255) NOT NULL DEFAULT '',
  auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
  auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY teams_enabled_idx (enabled),
  KEY teams_name_idx (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const spxBookingHistoryMigrationSql = `
CREATE TABLE IF NOT EXISTS spx_booking_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL DEFAULT 1,
  request_id BIGINT UNSIGNED NOT NULL,
  booking_id BIGINT UNSIGNED NULL,
  booking_name VARCHAR(255) NULL,
  agency_name VARCHAR(255) NULL,
  route VARCHAR(255) NOT NULL,
  origin VARCHAR(255) NULL,
  destination VARCHAR(255) NULL,
  cost_type VARCHAR(50) NULL,
  trip_type VARCHAR(50) NULL,
  shift_type VARCHAR(50) NULL,
  vehicle_type VARCHAR(50) NULL,
  standby_datetime VARCHAR(50) NULL,
  acceptance_status INT NULL,
  assignment_status INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id),
  KEY booking_id_idx (booking_id),
  KEY created_at_idx (created_at),
  KEY spx_booking_history_team_created_idx (team_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const notifyRulesMigrationSql = `
CREATE TABLE IF NOT EXISTS notify_rules (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  team_id INT NOT NULL DEFAULT 1,
  name VARCHAR(128) NOT NULL,
  origins VARCHAR(4000) NOT NULL DEFAULT '[]',
  destinations VARCHAR(4000) NOT NULL DEFAULT '[]',
  vehicle_types VARCHAR(4000) NOT NULL DEFAULT '[]',
  need INT NOT NULL DEFAULT 1,
  enabled INT NOT NULL DEFAULT 1,
  fulfilled INT NOT NULL DEFAULT 0,
  auto_accept INT NOT NULL DEFAULT 0,
  accept_all INT NOT NULL DEFAULT 0,
  auto_accepted INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY notify_rules_team_id_idx (team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const autoAcceptHistoryMigrationSql = `
CREATE TABLE IF NOT EXISTS auto_accept_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL DEFAULT 1,
  rule_id VARCHAR(255) NOT NULL,
  rule_name VARCHAR(128) NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  request_ids VARCHAR(2000) NOT NULL,
  accepted_count INT NOT NULL DEFAULT 0,
  origin VARCHAR(255) NOT NULL DEFAULT '',
  destination VARCHAR(255) NOT NULL DEFAULT '',
  vehicle_type VARCHAR(50) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'success',
  error_message VARCHAR(1000) NULL,
  failure_reason VARCHAR(64) NULL,
  trace_id VARCHAR(160) NULL,
  accept_rtt_ms INT NULL,
  list_age_ms INT NULL,
  verification_latency_ms INT NULL,
  verification_status VARCHAR(32) NULL,
  verified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY aah_created_at_idx (created_at),
  KEY aah_rule_id_idx (rule_id),
  KEY aah_status_created_at_idx (status, created_at),
  KEY aah_team_created_at_idx (team_id, created_at),
  KEY aah_team_status_created_at_idx (team_id, status, created_at),
  KEY aah_team_reason_created_at_idx (team_id, failure_reason, created_at),
  KEY aah_trace_id_idx (trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const metricsSnapshotsMigrationSql = `
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL DEFAULT 1,
  uptime INT NOT NULL,
  total_requests INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  success_rate VARCHAR(10) NOT NULL DEFAULT '0',
  latency_avg INT NOT NULL DEFAULT 0,
  latency_p95 INT NOT NULL DEFAULT 0,
  latency_p99 INT NOT NULL DEFAULT 0,
  total_records_seen INT NOT NULL DEFAULT 0,
  changes_detected INT NOT NULL DEFAULT 0,
  trips_inserted INT NOT NULL DEFAULT 0,
  trips_skipped INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY metrics_created_at_idx (created_at),
  KEY metrics_team_created_at_idx (team_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const lineBotSessionsMigrationSql = `
CREATE TABLE IF NOT EXISTS line_bot_sessions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_key VARCHAR(50) NOT NULL DEFAULT 'default',
  auth_token VARCHAR(2000) NOT NULL,
  device VARCHAR(50) NOT NULL DEFAULT 'IOSIPAD',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY lbs_session_key_idx (session_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const lineImageExtractionsMigrationSql = `
CREATE TABLE IF NOT EXISTS line_image_extractions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(255) NOT NULL,
  sender_id VARCHAR(255) NOT NULL,
  image_path VARCHAR(1000) NOT NULL,
  date_text VARCHAR(100) NOT NULL,
  trip_number VARCHAR(100) NOT NULL DEFAULT '',
  driver_name VARCHAR(500) NOT NULL,
  agency_name VARCHAR(100) NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL,
  route VARCHAR(255) NOT NULL,
  raw_text VARCHAR(4000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY lie_created_at_idx (created_at),
  KEY lie_agency_created_at_idx (agency_name, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const notificationEventsMigrationSql = `
CREATE TABLE IF NOT EXISTS notification_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(255) NOT NULL,
  schema_version INT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  team_id INT NOT NULL,
  worker_node_id VARCHAR(120) NOT NULL,
  trace_id VARCHAR(160) NULL,
  subject_type VARCHAR(64) NOT NULL,
  subject_id VARCHAR(160) NOT NULL,
  payload_json TEXT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY notification_events_event_key_uidx (event_key),
  KEY notification_events_team_received_idx (team_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const notificationOutboxMigrationSql = `
CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(255) NOT NULL,
  team_id INT NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_by VARCHAR(120) NULL,
  locked_until DATETIME NULL,
  sent_at DATETIME NULL,
  last_error VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY notification_outbox_event_key_uidx (event_key),
  KEY notification_outbox_status_available_idx (status, available_at),
  KEY notification_outbox_team_created_idx (team_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const notificationDeliveriesMigrationSql = `
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  outbox_id BIGINT UNSIGNED NOT NULL,
  delivery_attempt INT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  provider_message_id VARCHAR(255) NULL,
  error_message VARCHAR(1000) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  KEY notification_deliveries_outbox_idx (outbox_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const runtimeNodesMigrationSql = `
CREATE TABLE IF NOT EXISTS runtime_nodes (
  node_id VARCHAR(120) NOT NULL PRIMARY KEY,
  role VARCHAR(32) NOT NULL,
  hostname VARCHAR(255) NULL,
  pid INT NULL,
  version VARCHAR(120) NULL,
  last_heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY runtime_nodes_role_heartbeat_idx (role, last_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const teamRuntimeLeasesMigrationSql = `
CREATE TABLE IF NOT EXISTS team_runtime_leases (
  team_id INT NOT NULL PRIMARY KEY,
  owner_node_id VARCHAR(120) NOT NULL,
  owner_role VARCHAR(32) NOT NULL,
  lease_token VARCHAR(80) NOT NULL,
  lease_expires_at DATETIME NOT NULL,
  heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  last_error VARCHAR(1000) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY trl_owner_idx (owner_node_id),
  KEY trl_expires_idx (lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const teamRuntimeDesiredStateMigrationSql = `
CREATE TABLE IF NOT EXISTS team_runtime_desired_state (
  team_id INT NOT NULL PRIMARY KEY,
  desired_state VARCHAR(32) NOT NULL DEFAULT 'running',
  changed_by_user_id INT NULL,
  reason VARCHAR(1000) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const autoAcceptAttemptsMigrationSql = `
CREATE TABLE IF NOT EXISTS auto_accept_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  trace_id VARCHAR(160) NOT NULL,
  team_id INT NOT NULL,
  worker_node_id VARCHAR(120) NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  request_ids_json VARCHAR(2000) NOT NULL,
  rule_id VARCHAR(255) NULL,
  rule_name VARCHAR(128) NULL,
  accept_mode VARCHAR(32) NOT NULL,
  accept_started_at DATETIME NOT NULL,
  accept_finished_at DATETIME NULL,
  accept_rtt_ms INT NULL,
  spx_http_status INT NULL,
  spx_retcode INT NULL,
  spx_message VARCHAR(1000) NULL,
  raw_error VARCHAR(1000) NULL,
  ambiguous_accept INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY aaa_trace_uidx (trace_id),
  KEY aaa_team_booking_idx (team_id, booking_id),
  KEY aaa_worker_created_idx (worker_node_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const autoAcceptResultsMigrationSql = `
CREATE TABLE IF NOT EXISTS auto_accept_results (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NOT NULL,
  winning_attempt_trace_id VARCHAR(160) NULL,
  status VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  evidence_json TEXT NULL,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY aar_team_booking_request_uidx (team_id, booking_id, request_id),
  KEY aar_team_status_idx (team_id, status),
  KEY aar_trace_idx (winning_attempt_trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;

export const appSettingsMigrationSql = `
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(4000) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;
