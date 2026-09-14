CREATE TABLE IF NOT EXISTS realtime_execution_metrics (
  team_id INT NOT NULL,
  source_node_id VARCHAR(120) NOT NULL,
  generation VARCHAR(128) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  snapshot_json JSON NOT NULL,
  emitted_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  PRIMARY KEY (team_id, source_node_id),
  KEY realtime_execution_metrics_received_idx (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
