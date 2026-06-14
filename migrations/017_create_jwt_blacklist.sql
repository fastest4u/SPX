CREATE TABLE IF NOT EXISTS jwt_blacklist (
  jti VARCHAR(64) NOT NULL PRIMARY KEY,
  revoked_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  KEY jwt_blacklist_expires_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
