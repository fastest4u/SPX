CREATE TABLE IF NOT EXISTS auto_accept_verification_jobs (
  team_id INT NOT NULL,
  trace_id VARCHAR(160) NOT NULL,
  job_json MEDIUMTEXT NOT NULL,
  settled_json TEXT NOT NULL,
  notifications_json MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  response_ready INT NOT NULL DEFAULT 0,
  discovery_pending INT NOT NULL DEFAULT 0,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  lease_token VARCHAR(64) NULL,
  lease_until BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, trace_id),
  KEY aavj_team_due_idx (team_id, status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
