-- Add booking context and status tracking columns

ALTER TABLE spx_booking_history
  ADD COLUMN booking_id BIGINT UNSIGNED NULL AFTER request_id,
  ADD COLUMN booking_name VARCHAR(255) NULL AFTER booking_id,
  ADD COLUMN agency_name VARCHAR(255) NULL AFTER booking_name,
  ADD COLUMN acceptance_status INT NULL AFTER standby_datetime,
  ADD COLUMN assignment_status INT NULL AFTER acceptance_status,
  ADD INDEX booking_id_idx (booking_id);
