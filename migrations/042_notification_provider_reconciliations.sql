CREATE TABLE IF NOT EXISTS notification_provider_reconciliations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  outbox_id BIGINT UNSIGNED NOT NULL,
  provider_request_id VARCHAR(128) NOT NULL,
  provider_started_at DATETIME NOT NULL,
  expected_status VARCHAR(32) NOT NULL,
  action VARCHAR(32) NOT NULL,
  result_status VARCHAR(32) NOT NULL,
  actor_user_id INT NOT NULL,
  actor_username VARCHAR(50) NOT NULL,
  actor_team_id INT NULL,
  target_team_id INT NOT NULL,
  evidence_reference VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  provider_message_id VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY npr_outbox_provider_fence_uidx (outbox_id, provider_request_id, provider_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
