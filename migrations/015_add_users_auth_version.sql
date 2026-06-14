SET @users_auth_version_column_ddl = IF(
  (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = 'users'
      AND column_name = 'auth_version'
  ) = 0,
  'ALTER TABLE users ADD COLUMN auth_version INT NOT NULL DEFAULT 0 AFTER role',
  'SELECT 1'
);

PREPARE stmt FROM @users_auth_version_column_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
