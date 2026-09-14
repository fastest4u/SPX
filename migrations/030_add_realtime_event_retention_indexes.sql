SET @realtime_events_replayable_id_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'realtime_events'
    AND INDEX_NAME = 'realtime_events_replayable_id_idx'
);

SET @realtime_events_replayable_id_idx_sql := IF(
  @realtime_events_replayable_id_idx_exists = 0,
  'ALTER TABLE realtime_events ADD INDEX realtime_events_replayable_id_idx (replayable, id)',
  'SELECT 1'
);

PREPARE realtime_events_replayable_id_idx_stmt FROM @realtime_events_replayable_id_idx_sql;
EXECUTE realtime_events_replayable_id_idx_stmt;
DEALLOCATE PREPARE realtime_events_replayable_id_idx_stmt;

SET @realtime_events_replay_scope_id_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'realtime_events'
    AND INDEX_NAME = 'realtime_events_replay_scope_id_idx'
);

SET @realtime_events_replay_scope_id_idx_sql := IF(
  @realtime_events_replay_scope_id_idx_exists = 0,
  'ALTER TABLE realtime_events ADD INDEX realtime_events_replay_scope_id_idx (replayable, scope_kind, team_id, id)',
  'SELECT 1'
);

PREPARE realtime_events_replay_scope_id_idx_stmt FROM @realtime_events_replay_scope_id_idx_sql;
EXECUTE realtime_events_replay_scope_id_idx_stmt;
DEALLOCATE PREPARE realtime_events_replay_scope_id_idx_stmt;

SET @realtime_events_replay_created_id_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'realtime_events'
    AND INDEX_NAME = 'realtime_events_replay_created_id_idx'
);

SET @realtime_events_replay_created_id_idx_sql := IF(
  @realtime_events_replay_created_id_idx_exists = 0,
  'ALTER TABLE realtime_events ADD INDEX realtime_events_replay_created_id_idx (replayable, created_at, id)',
  'SELECT 1'
);

PREPARE realtime_events_replay_created_id_idx_stmt FROM @realtime_events_replay_created_id_idx_sql;
EXECUTE realtime_events_replay_created_id_idx_stmt;
DEALLOCATE PREPARE realtime_events_replay_created_id_idx_stmt;
