SET @notification_provider_execution_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_outbox'
    AND COLUMN_NAME = 'provider_execution_started_at'
);
SET @notification_provider_execution_sql := IF(
  @notification_provider_execution_exists = 0,
  'ALTER TABLE notification_outbox ADD COLUMN provider_execution_started_at DATETIME NULL',
  'SELECT 1'
);
PREPARE notification_provider_execution_stmt FROM @notification_provider_execution_sql;
EXECUTE notification_provider_execution_stmt;
DEALLOCATE PREPARE notification_provider_execution_stmt;
