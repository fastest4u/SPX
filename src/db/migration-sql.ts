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

export const notifyRulesMigrationSql = `
CREATE TABLE IF NOT EXISTS notify_rules (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  origins VARCHAR(4000) NOT NULL DEFAULT '[]',
  destinations VARCHAR(4000) NOT NULL DEFAULT '[]',
  vehicle_types VARCHAR(4000) NOT NULL DEFAULT '[]',
  need INT NOT NULL DEFAULT 1,
  enabled INT NOT NULL DEFAULT 1,
  fulfilled INT NOT NULL DEFAULT 0,
  auto_accept INT NOT NULL DEFAULT 0,
  auto_accepted INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  updated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()) ON UPDATE UTC_TIMESTAMP()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`;
