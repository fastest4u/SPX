CREATE TABLE IF NOT EXISTS team_spx_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  spx_cookie VARCHAR(4000) NOT NULL DEFAULT '',
  spx_device_id VARCHAR(1000) NOT NULL DEFAULT '',
  spx_app_name VARCHAR(1000) NOT NULL DEFAULT '',
  spx_referer VARCHAR(1000) NOT NULL DEFAULT '',
  enabled INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY team_spx_accounts_team_id_idx (team_id),
  KEY team_spx_accounts_team_enabled_idx (team_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
