SET @users_role_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'users'
      AND column_name = 'role'
  ) = 0,
  'ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT ''viewer'' AFTER password_hash',
  'SELECT 1'
);

PREPARE stmt FROM @users_role_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
