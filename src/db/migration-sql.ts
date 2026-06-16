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
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY aah_created_at_idx (created_at),
  KEY aah_rule_id_idx (rule_id),
  KEY aah_status_created_at_idx (status, created_at),
  KEY aah_team_created_at_idx (team_id, created_at),
  KEY aah_team_status_created_at_idx (team_id, status, created_at)
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

export const appSettingsMigrationSql = `
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(4000) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;
