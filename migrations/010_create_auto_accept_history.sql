CREATE TABLE IF NOT EXISTS auto_accept_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
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
  KEY aah_rule_id_idx (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
