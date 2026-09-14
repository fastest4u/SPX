CREATE TABLE IF NOT EXISTS spx_n_minus_one_probe_fixtures (
  probe_role VARCHAR(64) NOT NULL,
  probe_value BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (probe_role),
  CONSTRAINT spx_n_minus_one_probe_role_chk CHECK (
    probe_role IN (
      'web-api',
      'notification-service',
      'line-service',
      'worker-ifn-split',
      'worker-ptwl-split'
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO spx_n_minus_one_probe_fixtures (probe_role, probe_value)
VALUES
  ('web-api', 4101),
  ('notification-service', 4102),
  ('line-service', 4103),
  ('worker-ifn-split', 4104),
  ('worker-ptwl-split', 4105);
