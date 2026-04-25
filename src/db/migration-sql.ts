export const spxBookingHistoryMigrationSql = `
CREATE TABLE IF NOT EXISTS spx_booking_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  route VARCHAR(255) NOT NULL,
  origin VARCHAR(255) NULL,
  destination VARCHAR(255) NULL,
  cost_type VARCHAR(50) NULL,
  trip_type VARCHAR(50) NULL,
  shift_type VARCHAR(50) NULL,
  vehicle_type VARCHAR(50) NULL,
  standby_datetime VARCHAR(50) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY request_id_idx (request_id),
  KEY created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;
