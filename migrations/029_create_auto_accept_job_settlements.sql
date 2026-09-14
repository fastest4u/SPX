CREATE TABLE IF NOT EXISTS auto_accept_job_settlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  settlement_key VARCHAR(512) NOT NULL,
  job_id BIGINT UNSIGNED NOT NULL,
  team_id INT NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NOT NULL,
  rule_id VARCHAR(255) NOT NULL,
  settlement_step VARCHAR(32) NOT NULL,
  side_effect_id BIGINT UNSIGNED NULL,
  metadata_json TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY aajs_settlement_key_uidx (settlement_key),
  UNIQUE KEY aajs_job_step_uidx (job_id, settlement_step),
  KEY aajs_team_step_completed_idx (team_id, settlement_step, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
