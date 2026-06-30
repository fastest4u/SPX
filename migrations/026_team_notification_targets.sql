SET @teams_auto_accept_success_line_group_id_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'teams'
      AND column_name = 'auto_accept_success_line_group_id'
  ) = 0,
  'ALTER TABLE teams ADD COLUMN auto_accept_success_line_group_id VARCHAR(255) NOT NULL DEFAULT '''' AFTER line_group_id',
  'SELECT 1'
);
PREPARE stmt FROM @teams_auto_accept_success_line_group_id_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @teams_auto_accept_failure_line_group_id_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'teams'
      AND column_name = 'auto_accept_failure_line_group_id'
  ) = 0,
  'ALTER TABLE teams ADD COLUMN auto_accept_failure_line_group_id VARCHAR(255) NOT NULL DEFAULT '''' AFTER auto_accept_success_line_group_id',
  'SELECT 1'
);
PREPARE stmt FROM @teams_auto_accept_failure_line_group_id_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE teams
SET
  auto_accept_success_line_group_id = line_group_id,
  auto_accept_failure_line_group_id = line_group_id
WHERE line_group_id <> ''
  AND auto_accept_success_line_group_id = ''
  AND auto_accept_failure_line_group_id = '';
