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

ALTER TABLE users ADD COLUMN team_id INT NULL AFTER role;
UPDATE users SET team_id = 1 WHERE role <> 'admin' AND team_id IS NULL;
ALTER TABLE users ADD INDEX users_team_id_idx (team_id);

ALTER TABLE notify_rules ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE notify_rules ADD INDEX notify_rules_team_id_idx (team_id);

ALTER TABLE spx_booking_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE spx_booking_history DROP INDEX request_id_idx;
ALTER TABLE spx_booking_history ADD UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id);
ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_created_idx (team_id, created_at);

ALTER TABLE auto_accept_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE auto_accept_history ADD INDEX aah_team_created_at_idx (team_id, created_at);
ALTER TABLE auto_accept_history ADD INDEX aah_team_status_created_at_idx (team_id, status, created_at);

ALTER TABLE metrics_snapshots ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE metrics_snapshots ADD INDEX metrics_team_created_at_idx (team_id, created_at);

ALTER TABLE audit_logs ADD COLUMN team_id INT NULL AFTER id;
ALTER TABLE audit_logs ADD COLUMN actor_user_id INT NULL AFTER team_id;
ALTER TABLE audit_logs ADD COLUMN actor_team_id INT NULL AFTER actor_user_id;
ALTER TABLE audit_logs ADD COLUMN target_team_id INT NULL AFTER actor_team_id;
ALTER TABLE audit_logs ADD INDEX audit_target_team_created_at_idx (target_team_id, created_at);
