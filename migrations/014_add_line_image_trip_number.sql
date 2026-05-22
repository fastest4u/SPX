SET @line_image_trip_number_column_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'line_image_extractions'
    AND COLUMN_NAME = 'trip_number'
);

SET @line_image_trip_number_sql := IF(
  @line_image_trip_number_column_exists = 0,
  'ALTER TABLE line_image_extractions ADD COLUMN trip_number VARCHAR(100) NOT NULL DEFAULT '''' AFTER date_text',
  'SELECT 1'
);

PREPARE line_image_trip_number_stmt FROM @line_image_trip_number_sql;
EXECUTE line_image_trip_number_stmt;
DEALLOCATE PREPARE line_image_trip_number_stmt;
