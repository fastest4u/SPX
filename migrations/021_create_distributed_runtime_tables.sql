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

CREATE TABLE IF NOT EXISTS team_runtime_desired_state (
  team_id INT NOT NULL PRIMARY KEY,
  desired_state VARCHAR(32) NOT NULL DEFAULT 'running',
  changed_by_user_id INT NULL,
  reason VARCHAR(1000) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
