-- Frozen control-plane bootstrap. This is the only migration allowed to run
-- before the v2 history postconditions are available.
SET @spx_previous_lock_wait_timeout = @@SESSION.lock_wait_timeout;
SET SESSION lock_wait_timeout = 5;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum_sha256 CHAR(64) NULL,
  status VARCHAR(16) NULL,
  execution_mode VARCHAR(32) NULL,
  execution_sha256 CHAR(64) NULL,
  started_at DATETIME NULL,
  applied_at DATETIME NULL,
  failed_at DATETIME NULL,
  failed_statement_index INT UNSIGNED NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY schema_migrations_name_idx (name),
  KEY schema_migrations_checksum_idx (checksum_sha256),
  KEY schema_migrations_status_idx (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN checksum_sha256 CHAR(64) NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'checksum_sha256'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN status VARCHAR(16) NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'status'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN execution_mode VARCHAR(32) NULL AFTER status, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'execution_mode'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN execution_sha256 CHAR(64) NULL AFTER execution_mode, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'execution_sha256'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN started_at DATETIME NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'started_at'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN applied_at DATETIME NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'applied_at'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN failed_at DATETIME NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'failed_at'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN failed_statement_index INT UNSIGNED NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'failed_statement_index'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'attempt_count'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN last_error_code VARCHAR(64) NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'last_error_code'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND column_name = 'updated_at'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD UNIQUE KEY schema_migrations_name_idx (name), ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND index_name = 'schema_migrations_name_idx'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD KEY schema_migrations_checksum_idx (checksum_sha256), ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND index_name = 'schema_migrations_checksum_idx'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET @spx_history_ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE schema_migrations ADD KEY schema_migrations_status_idx (status), ALGORITHM=INPLACE, LOCK=NONE',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'schema_migrations'
    AND index_name = 'schema_migrations_status_idx'
);
PREPARE spx_history_statement FROM @spx_history_ddl;
EXECUTE spx_history_statement;
DEALLOCATE PREPARE spx_history_statement;

SET SESSION lock_wait_timeout = @spx_previous_lock_wait_timeout;
