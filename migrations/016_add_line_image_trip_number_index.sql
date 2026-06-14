SET @line_image_trip_number_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'line_image_extractions'
    AND INDEX_NAME = 'lie_trip_number_created_at_idx'
);

SET @line_image_trip_number_index_sql := IF(
  @line_image_trip_number_index_exists = 0,
  'ALTER TABLE line_image_extractions ADD INDEX lie_trip_number_created_at_idx (trip_number, created_at)',
  'SELECT 1'
);

PREPARE line_image_trip_number_index_stmt FROM @line_image_trip_number_index_sql;
EXECUTE line_image_trip_number_index_stmt;
DEALLOCATE PREPARE line_image_trip_number_index_stmt;
