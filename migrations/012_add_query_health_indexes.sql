SET @audit_created_at_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'audit_logs'
      AND index_name = 'audit_created_at_idx'
  ) = 0,
  'ALTER TABLE audit_logs ADD INDEX audit_created_at_idx (created_at)',
  'SELECT 1'
);

PREPARE stmt FROM @audit_created_at_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @audit_username_created_at_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'audit_logs'
      AND index_name = 'audit_username_created_at_idx'
  ) = 0,
  'ALTER TABLE audit_logs ADD INDEX audit_username_created_at_idx (username, created_at)',
  'SELECT 1'
);

PREPARE stmt FROM @audit_username_created_at_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @audit_action_created_at_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'audit_logs'
      AND index_name = 'audit_action_created_at_idx'
  ) = 0,
  'ALTER TABLE audit_logs ADD INDEX audit_action_created_at_idx (action, created_at)',
  'SELECT 1'
);

PREPARE stmt FROM @audit_action_created_at_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @aah_status_created_at_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'auto_accept_history'
      AND index_name = 'aah_status_created_at_idx'
  ) = 0,
  'ALTER TABLE auto_accept_history ADD INDEX aah_status_created_at_idx (status, created_at)',
  'SELECT 1'
);

PREPARE stmt FROM @aah_status_created_at_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
