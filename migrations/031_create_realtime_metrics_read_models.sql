CREATE TABLE IF NOT EXISTS realtime_metrics_read_models (
  team_id INT NOT NULL,
  source_node_id VARCHAR(120) NOT NULL,
  snapshot_json JSON NOT NULL,
  emitted_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (team_id),
  KEY realtime_metrics_read_models_received_team_idx (received_at, team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET @realtime_metrics_read_models_received_team_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'realtime_metrics_read_models'
    AND INDEX_NAME = 'realtime_metrics_read_models_received_team_idx'
);
SET @realtime_metrics_read_models_received_team_idx_sql := IF(
  @realtime_metrics_read_models_received_team_idx_exists = 0,
  'ALTER TABLE realtime_metrics_read_models ADD INDEX realtime_metrics_read_models_received_team_idx (received_at, team_id)',
  'SELECT 1'
);
PREPARE realtime_metrics_read_models_received_team_idx_stmt FROM @realtime_metrics_read_models_received_team_idx_sql;
EXECUTE realtime_metrics_read_models_received_team_idx_stmt;
DEALLOCATE PREPARE realtime_metrics_read_models_received_team_idx_stmt;
