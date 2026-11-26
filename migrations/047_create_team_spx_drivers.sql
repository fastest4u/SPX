CREATE TABLE IF NOT EXISTS team_spx_drivers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  driver_id INT NOT NULL,
  driver_name VARCHAR(255) NOT NULL,
  agency_name VARCHAR(255) NOT NULL DEFAULT '',
  vehicle_type INT NOT NULL,
  vehicle_type_name VARCHAR(100) NOT NULL DEFAULT '',
  enabled INT NOT NULL DEFAULT 1,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY team_spx_drivers_team_driver_uidx (team_id, driver_id),
  KEY team_spx_drivers_team_id_idx (team_id),
  KEY team_spx_drivers_team_vehicle_enabled_idx (team_id, vehicle_type, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
