-- Completes the effects of 018-020 when the current 001 baseline is used on a
-- history-empty database. Every DDL branch is idempotent for upgraded schemas.
CREATE TABLE IF NOT EXISTS teams (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  spx_cookie VARCHAR(4000) NOT NULL DEFAULT '',
  spx_device_id VARCHAR(1000) NOT NULL DEFAULT '',
  line_group_id VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY teams_enabled_idx (enabled),
  KEY teams_name_idx (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO teams (id, name, enabled, spx_cookie, spx_device_id, line_group_id)
VALUES (1, 'Default Team', 1, '', '', '')
ON DUPLICATE KEY UPDATE name = name;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE users ADD COLUMN team_id INT NULL AFTER role',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

UPDATE users SET team_id = 1 WHERE role <> 'admin' AND team_id IS NULL;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_team_id_idx') = 0,
  'ALTER TABLE users ADD INDEX users_team_id_idx (team_id)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notify_rules' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE notify_rules ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notify_rules' AND INDEX_NAME = 'notify_rules_team_id_idx') = 0,
  'ALTER TABLE notify_rules ADD INDEX notify_rules_team_id_idx (team_id)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spx_booking_history' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spx_booking_history' AND INDEX_NAME = 'request_id_idx') > 0,
  'ALTER TABLE spx_booking_history DROP INDEX request_id_idx',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spx_booking_history'
      AND INDEX_NAME = 'spx_booking_history_team_request_uidx') = 0,
  'ALTER TABLE spx_booking_history ADD UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'spx_booking_history'
      AND INDEX_NAME = 'spx_booking_history_team_created_idx') = 0,
  'ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_created_idx (team_id, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history'
      AND INDEX_NAME = 'aah_team_created_at_idx') = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_team_created_at_idx (team_id, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history'
      AND INDEX_NAME = 'aah_team_status_created_at_idx') = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_team_status_created_at_idx (team_id, status, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metrics_snapshots' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE metrics_snapshots ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metrics_snapshots'
      AND INDEX_NAME = 'metrics_team_created_at_idx') = 0,
  'ALTER TABLE metrics_snapshots ADD INDEX metrics_team_created_at_idx (team_id, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'team_id') = 0,
  'ALTER TABLE audit_logs ADD COLUMN team_id INT NULL AFTER id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'actor_user_id') = 0,
  'ALTER TABLE audit_logs ADD COLUMN actor_user_id INT NULL AFTER team_id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'actor_team_id') = 0,
  'ALTER TABLE audit_logs ADD COLUMN actor_team_id INT NULL AFTER actor_user_id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'target_team_id') = 0,
  'ALTER TABLE audit_logs ADD COLUMN target_team_id INT NULL AFTER actor_team_id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'
      AND INDEX_NAME = 'audit_target_team_created_at_idx') = 0,
  'ALTER TABLE audit_logs ADD INDEX audit_target_team_created_at_idx (target_team_id, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notify_rules' AND COLUMN_NAME = 'accept_all') = 0,
  'ALTER TABLE notify_rules ADD COLUMN accept_all INT NOT NULL DEFAULT 0 AFTER auto_accept',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'failure_reason') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN failure_reason VARCHAR(64) NULL AFTER error_message',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'trace_id') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN trace_id VARCHAR(160) NULL AFTER failure_reason',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'accept_rtt_ms') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN accept_rtt_ms INT NULL AFTER trace_id',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'list_age_ms') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN list_age_ms INT NULL AFTER accept_rtt_ms',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history'
      AND COLUMN_NAME = 'verification_latency_ms') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN verification_latency_ms INT NULL AFTER list_age_ms',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history'
      AND COLUMN_NAME = 'verification_status') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN verification_status VARCHAR(32) NULL AFTER verification_latency_ms',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND COLUMN_NAME = 'verified_at') = 0,
  'ALTER TABLE auto_accept_history ADD COLUMN verified_at DATETIME NULL AFTER verification_status',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history'
      AND INDEX_NAME = 'aah_team_reason_created_at_idx') = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_team_reason_created_at_idx (team_id, failure_reason, created_at)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;

SET @spx_034_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_accept_history' AND INDEX_NAME = 'aah_trace_id_idx') = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_trace_id_idx (trace_id)',
  'DO 0'
);
PREPARE spx_034_stmt FROM @spx_034_ddl;
EXECUTE spx_034_stmt;
DEALLOCATE PREPARE spx_034_stmt;
