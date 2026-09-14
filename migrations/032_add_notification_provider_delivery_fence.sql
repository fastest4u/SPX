SET @notification_outbox_provider_request_id_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_outbox'
    AND COLUMN_NAME = 'provider_request_id'
);
SET @notification_outbox_provider_request_id_sql := IF(
  @notification_outbox_provider_request_id_exists = 0,
  'ALTER TABLE notification_outbox ADD COLUMN provider_request_id VARCHAR(128) NULL AFTER locked_until',
  'SELECT 1'
);
PREPARE notification_outbox_provider_request_id_stmt FROM @notification_outbox_provider_request_id_sql;
EXECUTE notification_outbox_provider_request_id_stmt;
DEALLOCATE PREPARE notification_outbox_provider_request_id_stmt;

SET @notification_outbox_provider_started_at_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_outbox'
    AND COLUMN_NAME = 'provider_started_at'
);
SET @notification_outbox_provider_started_at_sql := IF(
  @notification_outbox_provider_started_at_exists = 0,
  'ALTER TABLE notification_outbox ADD COLUMN provider_started_at DATETIME NULL AFTER provider_request_id',
  'SELECT 1'
);
PREPARE notification_outbox_provider_started_at_stmt FROM @notification_outbox_provider_started_at_sql;
EXECUTE notification_outbox_provider_started_at_stmt;
DEALLOCATE PREPARE notification_outbox_provider_started_at_stmt;
