CREATE TABLE auto_accept_publication_controls (
  team_id INT NOT NULL,
  cutover_epoch VARCHAR(80) NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  state VARCHAR(16) NOT NULL,
  poller_node_id VARCHAR(120) NOT NULL,
  fence_job_id BIGINT UNSIGNED NULL,
  fence_requested_at DATETIME NULL,
  ack_node_id VARCHAR(120) NULL,
  ack_job_id BIGINT UNSIGNED NULL,
  acknowledged_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, cutover_epoch),
  UNIQUE KEY aapc_team_generation_uq (team_id, publication_generation),
  UNIQUE KEY aapc_team_epoch_generation_uq
    (team_id, cutover_epoch, publication_generation),
  KEY aapc_state_updated_idx (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auto_accept_publication_active_epochs (
  team_id INT NOT NULL PRIMARY KEY,
  active_epoch VARCHAR(80) NOT NULL,
  active_generation BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY aapa_team_generation_uq (team_id, active_generation),
  CONSTRAINT aapa_control_fk
    FOREIGN KEY (team_id, active_epoch, active_generation)
    REFERENCES auto_accept_publication_controls
      (team_id, cutover_epoch, publication_generation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE auto_accept_jobs
  ADD COLUMN cutover_epoch VARCHAR(80) NULL AFTER team_id,
  ADD COLUMN publication_generation BIGINT UNSIGNED NULL AFTER cutover_epoch,
  ADD KEY aaj_team_epoch_generation_status_idx
    (team_id, cutover_epoch, publication_generation, status),
  ALGORITHM=INPLACE,
  LOCK=NONE;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW operational_phase3_evidence AS
SELECT id, team_id, cutover_epoch, publication_generation, status,
       claim_owner, claim_expires_at,
       result_status, progress_settled_at, history_written_at,
       notification_enqueued_at, created_at, updated_at
FROM auto_accept_jobs;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW operational_phase3_control_evidence AS
SELECT c.team_id, c.cutover_epoch, c.publication_generation, c.state,
       c.poller_node_id, c.fence_job_id, c.fence_requested_at,
       c.ack_node_id, c.ack_job_id, c.acknowledged_at,
       (a.active_epoch = c.cutover_epoch
        AND a.active_generation = c.publication_generation) AS is_active,
       a.active_epoch, a.active_generation, c.created_at, c.updated_at
FROM auto_accept_publication_controls c
LEFT JOIN auto_accept_publication_active_epochs a ON a.team_id = c.team_id;
