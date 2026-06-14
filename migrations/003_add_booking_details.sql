-- Add booking context and status tracking columns.
-- Kept idempotent because newer baseline installs already create these fields
-- in 001_create_booking_requests.sql.

SET @spx_booking_history_booking_id_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND column_name = 'booking_id'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN booking_id BIGINT UNSIGNED NULL AFTER request_id',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_booking_id_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_booking_name_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND column_name = 'booking_name'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN booking_name VARCHAR(255) NULL AFTER booking_id',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_booking_name_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_agency_name_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND column_name = 'agency_name'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN agency_name VARCHAR(255) NULL AFTER booking_name',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_agency_name_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_acceptance_status_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND column_name = 'acceptance_status'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN acceptance_status INT NULL AFTER standby_datetime',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_acceptance_status_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_assignment_status_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND column_name = 'assignment_status'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD COLUMN assignment_status INT NULL AFTER acceptance_status',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_assignment_status_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_booking_id_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND index_name = 'booking_id_idx'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD INDEX booking_id_idx (booking_id)',
  'SELECT 1'
);
PREPARE stmt FROM @spx_booking_history_booking_id_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
