CREATE TABLE IF NOT EXISTS internal_request_replays (
  replay_key CHAR(64) NOT NULL,
  partition_name VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (replay_key),
  KEY internal_request_replays_partition_expires_idx (partition_name, expires_at),
  KEY internal_request_replays_expires_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
