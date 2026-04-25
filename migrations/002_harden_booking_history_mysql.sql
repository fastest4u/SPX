SET @spx_booking_history_needs_table_alter = (
  SELECT
    COUNT(*) > 0
    OR COALESCE((
      SELECT table_collation
      FROM information_schema.TABLES
      WHERE table_schema = DATABASE()
        AND table_name = 'spx_booking_history'
    ), '') <> 'utf8mb4_0900_ai_ci'
  FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'spx_booking_history'
    AND (
      (column_name = 'id' AND column_type <> 'bigint unsigned')
      OR (column_name = 'request_id' AND column_type <> 'bigint unsigned')
      OR (column_name = 'created_at' AND (data_type <> 'datetime' OR is_nullable <> 'NO'))
    )
);

SET @spx_booking_history_table_ddl = IF(
  @spx_booking_history_needs_table_alter,
  'ALTER TABLE spx_booking_history CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci, MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, MODIFY request_id BIGINT UNSIGNED NOT NULL, MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
  'SELECT 1'
);

PREPARE stmt FROM @spx_booking_history_table_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spx_booking_history_index_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE table_schema = DATABASE()
      AND table_name = 'spx_booking_history'
      AND index_name = 'created_at_idx'
  ) = 0,
  'ALTER TABLE spx_booking_history ADD INDEX created_at_idx (created_at)',
  'SELECT 1'
);

PREPARE stmt FROM @spx_booking_history_index_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
