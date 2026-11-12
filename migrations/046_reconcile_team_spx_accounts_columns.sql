SET @tsa_spx_email_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_email'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_email VARCHAR(254) NOT NULL DEFAULT '''' AFTER name',
  'SELECT 1'
);
PREPARE tsa_spx_email_stmt FROM @tsa_spx_email_ddl;
EXECUTE tsa_spx_email_stmt;
DEALLOCATE PREPARE tsa_spx_email_stmt;

SET @tsa_spx_password_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_password'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_password TEXT NULL AFTER spx_email',
  'SELECT 1'
);
PREPARE tsa_spx_password_stmt FROM @tsa_spx_password_ddl;
EXECUTE tsa_spx_password_stmt;
DEALLOCATE PREPARE tsa_spx_password_stmt;

SET @tsa_spx_auth_status_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_auth_status'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_auth_status VARCHAR(24) NOT NULL DEFAULT ''connected'' AFTER spx_referer',
  'SELECT 1'
);
PREPARE tsa_spx_auth_status_stmt FROM @tsa_spx_auth_status_ddl;
EXECUTE tsa_spx_auth_status_stmt;
DEALLOCATE PREPARE tsa_spx_auth_status_stmt;

SET @tsa_spx_auth_error_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_auth_error'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_auth_error VARCHAR(48) NULL AFTER spx_auth_status',
  'SELECT 1'
);
PREPARE tsa_spx_auth_error_stmt FROM @tsa_spx_auth_error_ddl;
EXECUTE tsa_spx_auth_error_stmt;
DEALLOCATE PREPARE tsa_spx_auth_error_stmt;

SET @tsa_spx_session_expires_at_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_session_expires_at'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_session_expires_at DATETIME NULL AFTER spx_auth_error',
  'SELECT 1'
);
PREPARE tsa_spx_session_expires_at_stmt FROM @tsa_spx_session_expires_at_ddl;
EXECUTE tsa_spx_session_expires_at_stmt;
DEALLOCATE PREPARE tsa_spx_session_expires_at_stmt;

SET @tsa_spx_last_login_at_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'team_spx_accounts'
      AND column_name = 'spx_last_login_at'
  ) = 0,
  'ALTER TABLE team_spx_accounts ADD COLUMN spx_last_login_at DATETIME NULL AFTER spx_session_expires_at',
  'SELECT 1'
);
PREPARE tsa_spx_last_login_at_stmt FROM @tsa_spx_last_login_at_ddl;
EXECUTE tsa_spx_last_login_at_stmt;
DEALLOCATE PREPARE tsa_spx_last_login_at_stmt;

SET @spx_booking_history_team_vehicle_idx_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'spx_booking_history'
      AND INDEX_NAME = 'spx_booking_history_team_vehicle_idx'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_vehicle_idx (team_id, vehicle_type)',
  'SELECT 1'
);
PREPARE spx_booking_history_team_vehicle_idx_stmt FROM @spx_booking_history_team_vehicle_idx_ddl;
EXECUTE spx_booking_history_team_vehicle_idx_stmt;
DEALLOCATE PREPARE spx_booking_history_team_vehicle_idx_stmt;

SET @spx_booking_history_team_created_id_idx_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'spx_booking_history'
      AND INDEX_NAME = 'spx_booking_history_team_created_id_idx'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_created_id_idx (team_id, created_at, id)',
  'SELECT 1'
);
PREPARE spx_booking_history_team_created_id_idx_stmt FROM @spx_booking_history_team_created_id_idx_ddl;
EXECUTE spx_booking_history_team_created_id_idx_stmt;
DEALLOCATE PREPARE spx_booking_history_team_created_id_idx_stmt;

SET @aah_team_id_idx_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auto_accept_history'
      AND INDEX_NAME = 'aah_team_id_idx'
  ) = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_team_id_idx (team_id, id)',
  'SELECT 1'
);
PREPARE aah_team_id_idx_stmt FROM @aah_team_id_idx_ddl;
EXECUTE aah_team_id_idx_stmt;
DEALLOCATE PREPARE aah_team_id_idx_stmt;

SET @aah_team_trace_idx_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auto_accept_history'
      AND INDEX_NAME = 'aah_team_trace_idx'
  ) = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_team_trace_idx (team_id, trace_id)',
  'SELECT 1'
);
PREPARE aah_team_trace_idx_stmt FROM @aah_team_trace_idx_ddl;
EXECUTE aah_team_trace_idx_stmt;
DEALLOCATE PREPARE aah_team_trace_idx_stmt;

SET @notification_deliveries_started_outbox_idx_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'notification_deliveries'
      AND INDEX_NAME = 'notification_deliveries_started_outbox_idx'
  ) = 0,
  'ALTER TABLE notification_deliveries ADD INDEX notification_deliveries_started_outbox_idx (started_at, outbox_id)',
  'SELECT 1'
);
PREPARE notification_deliveries_started_outbox_idx_stmt FROM @notification_deliveries_started_outbox_idx_ddl;
EXECUTE notification_deliveries_started_outbox_idx_stmt;
DEALLOCATE PREPARE notification_deliveries_started_outbox_idx_stmt;
