ALTER TABLE teams
  ADD COLUMN spx_email VARCHAR(254) NOT NULL DEFAULT '' AFTER bidding_vehicle_type,
  ADD COLUMN spx_password TEXT NULL AFTER spx_email,
  ADD COLUMN spx_auth_status VARCHAR(24) NOT NULL DEFAULT 'manual' AFTER spx_password,
  ADD COLUMN spx_auth_error VARCHAR(48) NULL AFTER spx_auth_status,
  ADD COLUMN spx_auth_retry_at DATETIME NULL AFTER spx_auth_error,
  ADD COLUMN spx_auth_failures INT NOT NULL DEFAULT 0 AFTER spx_auth_retry_at,
  ADD COLUMN spx_session_expires_at DATETIME NULL AFTER spx_auth_failures,
  ADD COLUMN spx_last_login_at DATETIME NULL AFTER spx_session_expires_at,
  ADD COLUMN spx_auth_epoch INT NOT NULL DEFAULT 0 AFTER spx_last_login_at,
  ADD COLUMN spx_auth_lease_token VARCHAR(64) NULL AFTER spx_auth_epoch,
  ADD COLUMN spx_auth_lease_until DATETIME NULL AFTER spx_auth_lease_token;
