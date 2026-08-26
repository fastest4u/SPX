SET @teams_rate_limit_notify_enabled_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'teams'
      AND column_name = 'rate_limit_notify_enabled'
  ) = 0,
  'ALTER TABLE teams ADD COLUMN rate_limit_notify_enabled INT NOT NULL DEFAULT 0 AFTER auto_accept_failure_line_group_id',
  'SELECT 1'
);
PREPARE stmt FROM @teams_rate_limit_notify_enabled_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
