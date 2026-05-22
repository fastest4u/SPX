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
