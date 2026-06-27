ALTER TABLE auto_accept_history ADD COLUMN failure_reason VARCHAR(64) NULL AFTER error_message;
ALTER TABLE auto_accept_history ADD COLUMN trace_id VARCHAR(160) NULL AFTER failure_reason;
ALTER TABLE auto_accept_history ADD COLUMN accept_rtt_ms INT NULL AFTER trace_id;
ALTER TABLE auto_accept_history ADD COLUMN list_age_ms INT NULL AFTER accept_rtt_ms;
ALTER TABLE auto_accept_history ADD COLUMN verification_latency_ms INT NULL AFTER list_age_ms;
ALTER TABLE auto_accept_history ADD COLUMN verification_status VARCHAR(32) NULL AFTER verification_latency_ms;
ALTER TABLE auto_accept_history ADD COLUMN verified_at DATETIME NULL AFTER verification_status;
ALTER TABLE auto_accept_history ADD INDEX aah_team_reason_created_at_idx (team_id, failure_reason, created_at);
ALTER TABLE auto_accept_history ADD INDEX aah_trace_id_idx (trace_id);
