SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'spx_booking_history'),
  'UPDATE spx_booking_history SET created_at = DATE_SUB(created_at, INTERVAL 7 HOUR) WHERE created_at > UTC_TIMESTAMP() + INTERVAL 1 HOUR',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'),
  'UPDATE users SET created_at = DATE_SUB(created_at, INTERVAL 7 HOUR) WHERE created_at > UTC_TIMESTAMP() + INTERVAL 1 HOUR',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'audit_logs'),
  'UPDATE audit_logs SET created_at = DATE_SUB(created_at, INTERVAL 7 HOUR) WHERE created_at > UTC_TIMESTAMP() + INTERVAL 1 HOUR',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'metrics_snapshots'),
  'UPDATE metrics_snapshots SET created_at = DATE_SUB(created_at, INTERVAL 7 HOUR) WHERE created_at > UTC_TIMESTAMP() + INTERVAL 1 HOUR',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
