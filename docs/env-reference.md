---
title: Env Reference
tags:
  - obsidian
  - spx
  - env
  - config
aliases:
  - ตัวแปร Environment
  - .env Reference
---

# Env Reference

> [!important] ไฟล์ `.env` ที่ root ของ project
>
> - โหลดอัตโนมัติผ่าน `src/config/env.ts` สำหรับ bootstrap/process identity เท่านั้น
> - Runtime/operator settings โหลดจาก `app_settings` หลังเชื่อมต่อ DB
> - แก้ไขค่า runtime ผ่าน Settings UI และ Teams UI แทนการแก้ `.env`; process-local boot flags and peer service client settings such as `HTTP_ENABLED` and `LINE_SERVICE_URL` stay in Docker/service environment

## Bootstrap Env

These values remain in `.env`: `NODE_ENV`, `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL_MODE`, `DB_SSL_CA_FILE`, `DB_SSL_SERVERNAME`, `SECRETS_KEY`.

## Database

| Variable      | Type   | Default | Required When                                |
| ------------- | ------ | ------- | -------------------------------------------- |
| `DB_HOST`     | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_PORT`     | int    | `3306`  | —                                            |
| `DB_USERNAME` | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_PASSWORD` | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_NAME`     | string | —       | DB-backed runtime config, dashboard, workers |
| `DB_SSL_MODE` | enum | `disabled` | Production DB roles require `verify-identity`; `DB_HOST` must be a DNS hostname present in the certificate SAN, not an IP literal |
| `DB_SSL_CA_FILE` | path | — | Required with `DB_SSL_MODE=verify-identity`; stable regular PEM CA bundle |
| `DB_SSL_SERVERNAME` | DNS name | `DB_HOST` | Certificate identity used for TLS SNI/verification; A3's `staging-db-proxy` requires the explicit approved upstream DNS name |
| `SECRETS_KEY` | string | —       | Production (minimum 32 characters); encrypt/decrypt DB-backed secrets |

Production never derives `SECRETS_KEY` from `JWT_SECRET` or `COOKIE_SECRET`. Keep it independent and stable across all processes that read or write encrypted application secrets; rotate it only through an explicit data re-encryption procedure.

## A3 Staging Operator Env

These non-secret values belong in the root-managed A3 staging runtime file, not in production application settings. N-1 probes remain default-off and run only through the signed `n-minus-one` profile.

| Variable | Purpose |
| -------- | ------- |
| `SPX_N_MINUS_ONE_IMAGE` | Immutable digest reference for the reviewed rollback image; the image must contain `dist/scripts/phase4-n-minus-one-role-probe.js` |
| `SPX_N_MINUS_ONE_RELEASE_SHA` | Exact 40-character source SHA for the N-1 image, used by immutable container identity labels and evidence |
| `STAGING_DB_UPSTREAM_HOST` | Approved direct staging MySQL DNS host reached only by the byte-transparent Phase 4 proxy |
| `STAGING_DB_UPSTREAM_PORT` | Approved staging MySQL port; default `3306` |
| `STAGING_DB_UPSTREAM_TLS_SERVERNAME` | Certificate-SAN DNS identity used by proxied realtime clients; never use the proxy service name or an IP literal |
| `STAGING_DB_PROXY_MAX_CONNECTIONS` | Positive bounded connection limit for the staging-only proxy; default `64` |

The five database-backed N-1 probes use their existing role-specific `SPX_DB_USERNAME_*` and password-file inputs against `spx_staging`. The OCR N-1 probe receives no database variables, CA mount, or database secret.

## Process Identity Env

These values remain process-local. Non-secret identities, authorization maps, and peer URLs are regular service environment values. Credentials are supplied through the matching `*_FILE` variable and loaded before runtime validation; they must not be moved into shared `app_settings`.

| Variable | Description |
| -------- | ----------- |
| `SPX_ROLE` | Process role: `api`, `worker`, `notifier`, `combined`, `notification-service`, `line-service`, `ocr-service`, `poller-service`, `auto-accept-service`, `realtime-service`, `gate6-control`, or `migrator` |
| `SPX_NODE_ID` | Stable, unique runtime node id for health/status tracking and signed internal requests |
| `SPX_NODE_NAME` | Optional display name for the runtime node |
| `RUN_TEAM_IDS` | Comma-separated team ids assigned to a worker, `poller-service`, or `auto-accept-service` process |
| `NOTIFIER_API_URL` | Worker/poller/auto-accept notification endpoint; HTTP(S) only, no credentials/query/fragment, normalized to `/internal/notification-events` |
| `NOTIFIER_LOCAL_SPOOL_PATH` | Process-local retry spool path; every process must use a distinct file |
| `NOTIFICATION_NODE_SECRET` | Caller-only outbound HMAC secret for this `SPX_NODE_ID`; production requires at least 32 characters and a unique value per node |
| `NOTIFICATION_NODE_SECRETS` | Notification receiver-only map of caller node ids to active/rotating HMAC keys |
| `NOTIFICATION_ALLOWED_NODE_TEAMS` | Notification receiver-only `node-id:teamId,teamId` allowlist; keys must exactly match `NOTIFICATION_NODE_SECRETS` |
| `NOTIFIER_SHARED_SECRET` | Legacy local/test compatibility fallback only; never a production notification identity boundary |
| `HTTP_ENABLED` | Process-local HTTP boot flag; keep `false` for headless roles and `true` for HTTP surfaces |
| `HTTP_PORT` | Fastify HTTP port for the current HTTP surface |
| `LINE_SERVICE_URL` | Split LINE HTTP(S) origin only; paths, credentials, query, and fragments are rejected |
| `LINE_SERVICE_SEND_SECRET` | Caller-only per-node LINE send signing secret for web-api or notification-service |
| `LINE_SERVICE_SEND_NODE_SECRETS` | line-service-only map of allowed caller node ids to active/rotating LINE send keys |
| `LINE_SERVICE_ADMIN_SECRET` | Process-local web-api-to-line-service admin/status signing secret; keep off DB-backed shared settings |
| `LINE_SERVICE_REQUEST_TIMEOUT_MS` | Process-local timeout for signed calls to split `line-service` |
| `OCR_SERVICE_URL` | Split OCR HTTP(S) origin only; paths, credentials, query, and fragments are rejected |
| `OCR_NODE_SECRET` | Caller-only outbound OCR HMAC secret for the current `SPX_NODE_ID`; production requires at least 32 characters |
| `OCR_NODE_SECRETS` | OCR receiver-only map of permitted LINE and admin caller node ids to active/rotating HMAC keys |
| `OCR_ALLOWED_LINE_NODE_IDS` | OCR receiver-only node ids authorized for image-read requests |
| `OCR_ADMIN_NODE_IDS` | OCR receiver-only node ids authorized for auth status/start/complete/logout; must not overlap LINE caller ids |
| `OCR_REPLAY_LEDGER_DIR` | Durable DB-free replay ledger directory for `ocr-service`; production requires a canonical absolute path under `/app/data/` and Compose uses `/app/data/internal-replay` |
| `OCR_SERVICE_ADMIN_SECRET` | Legacy local/test web-to-OCR fallback only; production admin calls use `OCR_NODE_SECRET` |
| `OCR_SERVICE_REQUEST_TIMEOUT_MS` | Process-local timeout for signed calls to split `ocr-service` |
| `CODEX_IMAGE_PROVIDER` | OCR provider; production `ocr-service` requires `codex-device` |
| `CODEX_IMAGE_MODEL` | Server-controlled OCR model override |
| `CODEX_IMAGE_TIMEOUT_MS` | Positive OCR provider timeout in milliseconds |
| `CODEX_IMAGE_MAX_BYTES` | Positive maximum decoded image size in bytes |
| `GATE6_REPOSITORY` | Exact `owner/repository` identity bound into production permits and active fault context; required only by `gate6-control` |
| `SPX_DB_USERNAME_GATE6_CONTROL` / `SPX_DB_PASSWORD_GATE6_CONTROL_FILE` | Dedicated Gate 6 control principal and root-owned password file; Task 9 reaches it only through `gate6-db-proxy` |
| `SPX_GATE6_DB_PASSWORD_SHA256` / `SPX_GATE6_DB_CA_SHA256` | Lowercase SHA-256 bindings for the Task 9 controller's mounted DB credential and CA; mismatches fail before connecting |
| `SPX_GATE6_PRODUCTION_KEYRING_PATH` | Root-owned canonical production Gate 6 public-key ring mounted read-only into the one-shot Task 9 controller; it must satisfy `deploy/gate6-production-keyring.schema.json` and the stricter runtime checks below |
| `SPX_GATE6_TASK9_REQUEST_CONFIG_PATH` | Root-owned canonical request definitions for the exact LINE baseline/fault and OCR fixture call; mutation fields are not CLI inputs |
| `SPX_GATE6_TASK9_LINE_CALLER_SECRET_FILE` / `SPX_GATE6_TASK9_OCR_CALLER_SECRET_FILE` | Distinct caller-only HMAC files mounted into the Task 9 controller; the values must differ and are never provider credentials |
| `SPX_DB_USERNAME_GATE6_MONITOR` | Dedicated `gate6-monitor-probe` MySQL principal; grant contract allows read-only access to queue, outbox, and runtime-lease health only |
| `SPX_DB_PASSWORD_GATE6_MONITOR_FILE` | Root-owned password file for the monitor principal; the account is verified with `MAX_USER_CONNECTIONS 1` and receives no `PROCESS`, `SUPER`, write, or DDL privilege |
| `GATE6_CONTROL_NODE_SECRET` | Caller-only HMAC secret mounted separately into LINE and OCR; never shared between the two services |
| `GATE6_LINE_NODE_SECRETS` | `gate6-control` inbound key ring containing only approved LINE service node identities |
| `GATE6_OCR_NODE_SECRETS` | `gate6-control` inbound key ring containing only approved OCR service node identities; node ids and key material must be disjoint from LINE |
| `GATE6_LINE_PERMIT_KEY_ID` / `GATE6_OCR_PERMIT_KEY_ID` | Distinct pinned Ed25519 verification key ids for signed one-shot fault permits |
| `GATE6_LINE_PERMIT_PUBLIC_KEY_FILE` / `GATE6_OCR_PERMIT_PUBLIC_KEY_FILE` | Stable regular public-key files mounted only into the matching boundary service; private signing keys are forbidden from runtime containers |
| `GATE6_CONTROL_REQUEST_TIMEOUT_MS` | Positive timeout for internal service-to-control calls; default `1500` |
| `REALTIME_SERVICE_URL` | Optional remote realtime origin or exact `/internal/realtime` base path; leave unset for local handlers and empty on `realtime-service` itself |
| `REALTIME_SHARED_SECRET` | Client-only outbound secret for the current `SPX_NODE_ID`; assign a unique value per node and never use one cluster-wide secret |
| `REALTIME_REQUEST_TIMEOUT_MS` | Positive remote realtime request timeout in milliseconds; default `1500` |
| `REALTIME_TRUSTED_NODE_IDS` | Server-only comma-separated set of all nodes allowed to call `realtime-service` |
| `REALTIME_ADMIN_NODE_IDS` | Server-only comma-separated subset explicitly authorized for admin-scope reads/publishes |
| `REALTIME_ALLOWED_NODE_TEAMS` | Server-only `node-id:teamId,teamId` entries separated by semicolons for team-scoped callers |
| `REALTIME_NODE_SECRETS` | Inbound-only compact `node-id=secret` map or strict JSON rotation map; do not print, log, or commit it |

The Gate 6 production keyring is public material only. Its exact `keyIds` object
must define `envelope`, `linePermit`, `ocrPermit`, and `postproof`; `keys` must
contain exactly those four IDs. Every value must be a canonical Ed25519 SPKI
`PUBLIC KEY` PEM. The runtime rejects private-key PEMs, extra keys, duplicate
IDs, and duplicate normalized public-key fingerprints. Rotate with a reviewed
keyring replacement rather than placing current and previous roles into one
global trust set.

Gate 6 protected GitHub environments also require the following repository or
environment variables (these are not application `.env` values):

- `SPX_TRUSTED_GATE6_ENVELOPE_SIGNER_SHA`, `SPX_TRUSTED_GATE6_LINE_PERMIT_SIGNER_SHA`, `SPX_TRUSTED_GATE6_OCR_PERMIT_SIGNER_SHA`, `SPX_TRUSTED_GATE6_POSTPROOF_SIGNER_SHA`, and `SPX_TRUSTED_GATE6_RUNTIME_EXECUTOR_SHA`
- `SPX_GATE6_ENVELOPE_SIGNER_URL`, `SPX_GATE6_LINE_PERMIT_SIGNER_URL`, `SPX_GATE6_OCR_PERMIT_SIGNER_URL`, and `SPX_GATE6_POSTPROOF_SIGNER_URL`
- `SPX_GATE6_ENVELOPE_KEY_ID`, `SPX_GATE6_LINE_PERMIT_KEY_ID`, `SPX_GATE6_OCR_PERMIT_KEY_ID`, and `SPX_GATE6_POSTPROOF_KEY_ID`

All trusted workflow SHAs are full 40-character commit IDs. The four role key
IDs must match the host keyring; LINE/OCR service verification keys must also
match their corresponding role material before Task 9 is authorized. During protected
evidence activation, producer SHA variables name producer snapshot A, while the five
Gate 6 consumer signer/runtime variables above name the later map/consumer snapshot B.
They are all-zero together before activation but must not be collapsed to one SHA after
the reviewed three-commit bootstrap.

### Protected evidence producer workflow settings

The following names belong to GitHub repository/protected-environment configuration,
not the application `.env`. This reference intentionally records purpose only; obtain
and approve every value through the protected bootstrap process.

| Variable | Purpose |
| --- | --- |
| `SPX_TRUSTED_DEPLOY_WORKFLOW_SHA` | Full reviewed commit SHA authorized to run the trusted deploy and protected-install producer |
| `SPX_TRUSTED_RELEASE_WORKFLOW_SHA` | Full reviewed signer SHA required for the immutable release artifact |
| `SPX_TRUSTED_DESCRIPTOR_SIGNER_SHA` | Full reviewed signer SHA required for the target descriptor artifact |
| `SPX_TRUSTED_STAGING_SIGNER_SHA` | Full reviewed signer SHA required for the staging rollout approval artifact |
| `SPX_TRUSTED_STAGING_PROTECTED_EVIDENCE_WORKFLOW_SHA` | Full reviewed commit SHA authorized to run the protected staging-evidence producer |
| `SPX_DESCRIPTOR_KEY_ID` | Approved target-descriptor signing key identity |
| `SPX_DESCRIPTOR_PUBLIC_KEY_B64` | Approved public verification key for target descriptors |
| `SPX_DESCRIPTOR_OIDC_AUDIENCE` | Exact OIDC audience authorized for descriptor signing |
| `SPX_DESCRIPTOR_SIGNER_FILE_SHA256` | Exact digest of the trusted descriptor signer workflow file |
| `SPX_TARGET_FACTS_SHA256` | Digest binding for protected target facts |
| `SPX_TARGET_HOST_IDENTITY_SHA256` | Digest binding for the protected target host identity |
| `SPX_APPROVED_PRODUCTION_TOPOLOGY` | Exact production topology admitted by trusted deploy |
| `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_SHA256` | Digest binding for the protected candidate-identity approval capability |
| `SPX_STAGING_ACTION_CAPABILITY_BUNDLE_SHA256` | Digest binding for the protected staging action-capability bundle |
| `SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA` | Full reviewed commit SHA authorized to run and attest the protected backup/isolated-restore producer |
| `SPX_PRODUCTION_BACKUP_WORKFLOW_FILE_SHA256` | Exact digest of the trusted backup producer workflow file at its authorized commit |
| `SPX_PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256` | Exact digest of the backup evidence verifier loaded from trusted workflow code |
| `SPX_PRODUCTION_BACKUP_CONTROLLER_SHA256` | Exact digest of the fixed backup/restore controller |
| `SPX_PRODUCTION_BACKUP_LIVE_ADAPTER_SHA256` | Exact digest of the production backup live adapter |
| `SPX_PRODUCTION_BACKUP_INVARIANTS_SHA256` | Exact digest of the code-owned invariant/query allowlist |
| `SPX_PRODUCTION_BACKUP_ISOLATED_COMPOSE_SHA256` | Exact digest of the fixed isolated-restore Compose definition |
| `SPX_PRODUCTION_BACKUP_SOURCE_CREDENTIAL_SHA256` | Digest binding for the root-owned read-only source credential file |
| `SPX_PRODUCTION_BACKUP_KMS_CAPABILITY_SHA256` | Digest binding for the root-owned least-privilege KMS capability file |
| `SPX_PRODUCTION_BACKUP_MYSQLDUMP_SHA256` | Independently attested digest of fixed `/usr/bin/mysqldump` |
| `SPX_PRODUCTION_BACKUP_MYSQL_SHA256` | Independently attested digest of fixed `/usr/bin/mysql` |
| `SPX_PRODUCTION_BACKUP_DOCKER_SHA256` | Independently attested digest of fixed `/usr/bin/docker` |
| `SPX_PRODUCTION_BACKUP_KMS_ENVELOPE_SHA256` | Independently attested digest of fixed `/usr/local/libexec/spx-kms-envelope` |
| `SPX_PRODUCTION_BACKUP_KMS_KEY_ID` | Approved KMS key identity used for backup envelope encryption/decryption |
| `SPX_PRODUCTION_BACKUP_EVIDENCE_SIGNING_KEY_ID` | Approved KMS key identity used to sign backup evidence |
| `SPX_PRODUCTION_BACKUP_MYSQL_IMAGE` | Exact digest-pinned MySQL image allowed only for the isolated restore |
| `SPX_PRODUCTION_BACKUP_MAXIMUM_AGE_MINUTES` | Maximum accepted age of backup evidence |
| `SPX_PRODUCTION_BACKUP_MAXIMUM_RPO_MINUTES` | Maximum accepted backup recovery-point interval |
| `SPX_PRODUCTION_BACKUP_MAXIMUM_RTO_MINUTES` | Maximum accepted isolated-restore recovery time |
| `SPX_PROTECTED_INSTALL_EVIDENCE_WORKFLOW_FILE_SHA256` | Exact digest of the trusted deploy workflow file that produced protected-install evidence |
| `SPX_PROTECTED_INSTALL_EVIDENCE_ASSEMBLER_SHA256` | Exact digest of the protected-install evidence assembler |
| `SPX_PROTECTED_INSTALL_EVIDENCE_SCHEMA_SHA256` | Exact digest of the protected-install evidence schema |
| `SPX_PROTECTED_INSTALL_EVIDENCE_SIGNING_KEY_ID` | Approved KMS key identity used to sign protected-install evidence |
| `SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA` | Full reviewed commit SHA authorized to export accepted DB-transition and pre-close evidence |
| `SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_WORKFLOW_SHA256` | Exact digest of the accepted-evidence exporter workflow file |
| `SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_MODULE_SHA256` | Exact digest of the accepted-evidence host exporter module |
| `SPX_TRUSTED_GATE6_FINAL_VERIFIER_EXPORTER_SHA` | Full reviewed commit SHA authorized to export final-verifier evidence |
| `SPX_GATE6_FINAL_VERIFIER_EXPORTER_WORKFLOW_SHA256` | Exact digest of the final-verifier exporter workflow file |
| `SPX_GATE6_FINAL_VERIFIER_EXPORTER_MODULE_SHA256` | Exact digest of the final-verifier host exporter module |

These producer workflows reuse the following protected-environment secrets. Record
only their names and roles; never place their values in this document, dispatch
inputs, artifacts, logs, or the application `.env`.

| Secret | Purpose |
| --- | --- |
| `SPX_HOST` | Protected target host selector |
| `SPX_PORT` | Protected SSH port selector |
| `SPX_USER` | Restricted SSH principal |
| `SPX_SSH_KEY` | Protected SSH private-key capability |
| `SPX_KNOWN_HOSTS` | Pinned SSH host-key material; `SPX_KNOWN_HOSTS_SHA256` binds its exact bytes |
| `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_B64` | Protected candidate-identity approval capability bound by `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_SHA256` |
| `SPX_STAGING_ACTION_CAPABILITY_BUNDLE_B64` | Protected staging action-capability bundle bound by `SPX_STAGING_ACTION_CAPABILITY_BUNDLE_SHA256` |

Backup database and KMS capabilities are not GitHub secrets or dispatcher inputs.
They are separately provisioned root-owned read-only files at
`/run/credentials/spx-production-backup-source.cnf` and
`/run/credentials/spx-production-backup-kms.json`; only their approved digests enter
the protected workflow context.

Phase 3 process controls are also process-local and default-off unless the Compose profile sets them explicitly:

| Variable | Purpose |
| -------- | ------- |
| `AUTO_ACCEPT_JOB_SHADOW_ENABLED` | Publish shadow durable jobs from a poller-capable role without enabling cutover execution |
| `AUTO_ACCEPT_JOB_DRY_RUN_WORKER_ENABLED` | Run the non-mutating dry-run consumer loop |
| `AUTO_ACCEPT_JOB_DRY_RUN_INTERVAL_MS` | Dry-run loop interval; positive integer, default `1000` |
| `AUTO_ACCEPT_JOB_DRY_RUN_BATCH_SIZE` | Dry-run claim batch size; positive integer, default `10` |
| `AUTO_ACCEPT_JOB_DRY_RUN_LEASE_MS` | Dry-run claim lease; positive integer, default `300000` |
| `AUTO_ACCEPT_JOB_REAL_WORKER_ENABLED` | Run the mutating auto-accept consumer loop |
| `AUTO_ACCEPT_JOB_REAL_INTERVAL_MS` | Real loop interval; positive integer, default `1000` |
| `AUTO_ACCEPT_JOB_REAL_BATCH_SIZE` | Real claim batch size; positive integer, default `10` |
| `AUTO_ACCEPT_JOB_REAL_LEASE_MS` | Real claim lease; positive integer, default `300000` |
| `AUTO_ACCEPT_JOB_SETTLEMENT_WORKER_ENABLED` | Run canonical result settlement and notification publication |
| `AUTO_ACCEPT_JOB_SETTLEMENT_INTERVAL_MS` | Settlement loop interval; positive integer, default `1000` |
| `AUTO_ACCEPT_JOB_SETTLEMENT_BATCH_SIZE` | Settlement batch size; positive integer, default `10` |
| `AUTO_ACCEPT_JOB_SETTLEMENT_LEASE_MS` | Settlement lease; positive integer, default `300000` |
| `AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_ENABLED` | Route selected pending-request work to the durable boundary |
| `AUTO_ACCEPT_JOB_PENDING_REQUEST_CUTOVER_TEAM_IDS` | Positive team ids selected for pending-request cutover; required when its flag is true |
| `AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_ENABLED` | Route selected fast-accept-all work to the durable boundary |
| `AUTO_ACCEPT_JOB_FAST_ACCEPT_ALL_CUTOVER_TEAM_IDS` | Positive team ids selected for fast-accept-all cutover; required when its flag is true |

HTTP surface by role:

| Role                   | HTTP Surface                  | Notes                                                                                               |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `api`                  | web API/dashboard             | Serves dashboard, public health/readiness, authenticated API routes, and SPA assets                 |
| `notifier`             | web API/dashboard             | Legacy compatibility role; also runs notification dispatch                                          |
| `combined`             | web API/dashboard             | Local/development role that keeps current all-in-one behavior                                       |
| `worker`               | none                          | Does not expose HTTP; publishes to `NOTIFIER_API_URL`                                               |
| `notification-service` | internal notification service | Exposes signed notification intake, runtime metrics intake, and health/readiness                    |
| `line-service`         | internal LINE service         | Exposes signed LINE send/status/admin routes plus health/readiness; does not serve dashboard routes |
| `ocr-service`          | internal OCR service          | Exposes signed LINE image OCR route plus health/readiness; does not serve dashboard routes          |
| `poller-service`       | none                          | Dedicated team-scoped poller and durable job producer                                               |
| `auto-accept-service`  | none                          | Dedicated team-scoped durable auto-accept consumer/settlement process                               |
| `realtime-service`     | internal realtime service     | Exposes signed event, read-model, and SSE endpoints plus health/readiness on port `3005`            |

`SPX_NODE_ID` is required for distributed roles: `worker`, `notifier`, `notification-service`, `line-service`, `ocr-service`, `poller-service`, `auto-accept-service`, and `realtime-service`. Dashboard auth settings such as `JWT_SECRET`, `COOKIE_SECRET`, and `ADMIN_PASSWORD` are required only for roles that expose the web API/dashboard surface.

For split-service production, each running process must have a unique `SPX_NODE_ID`, including each worker machine. Keep `RUN_TEAM_IDS` explicit and non-overlapping by default; for example, `worker-ifn` can run `RUN_TEAM_IDS=2` while `worker-ptwl` runs `RUN_TEAM_IDS=1`.

Production notification authentication does not fall back to `NOTIFIER_SHARED_SECRET`: every worker, poller, auto-accept process, and Task 9 publisher uses its own `NOTIFICATION_NODE_SECRET`. The notification receiver requires `NOTIFICATION_NODE_SECRETS` and `NOTIFICATION_ALLOWED_NODE_TEAMS` to contain the same node ids. Production OCR callers use their own `OCR_NODE_SECRET`; `ocr-service` requires an exact `OCR_NODE_SECRETS` map and classifies every caller exactly once in either `OCR_ALLOWED_LINE_NODE_IDS` or `OCR_ADMIN_NODE_IDS`.

Compact inbound maps use `node-id=secret` entries separated by commas. For rotation, use strict JSON such as `{"worker-01":{"active":"...","previous":"...","previousExpiresAt":"2026-07-14T08:00:00.000Z"}}`. `previous` and `previousExpiresAt` must appear together, the timestamp must be exact ISO UTC, and previous-key acceptance is capped at 7 days. Secrets must be at least 32 characters and unique across all nodes and key generations in the map.

Remote realtime routing is opt-in. `REALTIME_SERVICE_URL` accepts only HTTP(S), rejects credentials, query parameters, and fragments, and accepts only an origin root or the exact `/internal/realtime` path. The runtime normalizes the origin root to `/internal/realtime`. A client with this URL must also set `SPX_NODE_ID`, its own `REALTIME_SHARED_SECRET`, and a positive `REALTIME_REQUEST_TIMEOUT_MS`. The `realtime-service` process must leave `REALTIME_SERVICE_URL` empty.

On `realtime-service`, every trusted node must be classified exactly one time as either an admin node in `REALTIME_ADMIN_NODE_IDS` or a team-scoped node in `REALTIME_ALLOWED_NODE_TEAMS`, never both. `REALTIME_NODE_SECRETS` keys exactly equal `REALTIME_TRUSTED_NODE_IDS`; keys are at least 32 characters and unique across nodes and active/previous generations. Every request carries a separately signed `x-spx-request-id` and is rejected on transport replay.

Compose maps distinct host inputs into application variables. Examples: `SPX_REALTIME_WEB_API_URL` becomes web's `REALTIME_SERVICE_URL`; `SPX_REALTIME_SHARED_SECRET_WEB_API_FILE` is mounted as web's `REALTIME_SHARED_SECRET_FILE`; and `SPX_REALTIME_NODE_SECRETS_WEB_API_FILE` is mounted only on web's rollback intake. Realtime-service receives `SPX_REALTIME_NODE_SECRETS_REALTIME_SERVICE_FILE`. LINE and OCR receive none of these realtime credentials.

Production Compose neither loads nor mounts `.env`. `/etc/spx/compose.env` contains non-secret configuration plus paths to root-managed secret files. Each container receives only its role's mounted files; there is no shared data bind mount and no cluster-wide outbound key.

Legacy shared realtime authentication is non-production compatibility only. Whenever a node map is configured, it is authoritative: every unmapped team or admin identity is rejected without shared-key fallback.

Internal service URLs:

| Variable                          | Used By                                    | Example                                                                                                                                              |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFIER_API_URL`                | workers                                    | `http://notification-service:3002/internal/notification-events` in split mode, or `http://notifier:3000/internal/notification-events` in legacy mode |
| `NOTIFICATION_NODE_SECRET`        | each notification producer                | unique outbound key matching that producer's `SPX_NODE_ID`                                                                                           |
| `NOTIFICATION_NODE_SECRETS`       | notification receiver                     | inbound map containing only allowed producer node ids and their unique keys                                                                           |
| `NOTIFICATION_ALLOWED_NODE_TEAMS` | notification receiver                     | exact node/team authorization map matching the inbound key map                                                                                        |
| `LINE_SERVICE_URL`                | notification-service, production legacy notifier, web API proxy routes | `http://line-service:3003`; current production rollout is split-only                                                                                |
| `LINE_SERVICE_SEND_SECRET`        | web API and notification-service callers | distinct generated value for each caller node                                                                                                  |
| `LINE_SERVICE_SEND_NODE_SECRETS`  | line-service only                         | map whose keys exactly match `LINE_SEND_ALLOWED_NODE_IDS`; supports bounded key rotation                                                       |
| `LINE_SERVICE_ADMIN_SECRET`       | web API and line-service only             | generated per split cutover                                                                                                                         |
| `LINE_SERVICE_REQUEST_TIMEOUT_MS` | notification-service, web API proxy routes | `1500`                                                                                                                                               |
| `OCR_SERVICE_URL`                 | line-service and web API                   | `http://ocr-service:3004`                                                                                                                            |
| `OCR_NODE_SECRET`                 | each OCR client                            | unique outbound key matching that client's `SPX_NODE_ID`                                                                                             |
| `OCR_NODE_SECRETS`                | OCR service                                | exact inbound map for classified LINE/admin callers                                                                                                  |
| `OCR_SERVICE_REQUEST_TIMEOUT_MS`  | line-service                               | `305000`                                                                                                                                             |
| `REALTIME_SERVICE_URL`            | web and selected event producers           | `http://realtime-service:3005` or `http://realtime-service:3005/internal/realtime`                                                                    |
| `REALTIME_SHARED_SECRET`          | each remote realtime client                | unique outbound secret matching that client's `SPX_NODE_ID`                                                                                           |
| `REALTIME_REQUEST_TIMEOUT_MS`     | each remote realtime client                | `1500`                                                                                                                                                |

Split-service internal endpoints:

| Surface                | Endpoints                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-service` | `POST /internal/notification-events`, `POST /internal/runtime-metrics`                                                                                                                                              |
| `line-service`         | `POST /internal/line/messages`, `POST /internal/line/status`, `POST /internal/line/login`, `POST /internal/line/groups`, `POST /internal/line/profile`, `POST /internal/line/storage`, `POST /internal/line/logout` |
| `ocr-service`          | `POST /internal/ocr/line-image`                                                                                                                                                                                     |
| `realtime-service`     | `POST /internal/realtime/events`, `POST /internal/realtime/read-models/metrics`, `POST /internal/realtime/read-models/metrics-history`, `POST /internal/realtime/read-models/runtime-status`, `POST /internal/realtime/stream` |

Worker-to-notification-service endpoints use the caller's `NOTIFICATION_NODE_SECRET`; the receiver verifies it against `NOTIFICATION_NODE_SECRETS` before applying `NOTIFICATION_ALLOWED_NODE_TEAMS`. In production, only notification-service receives `LINE_SERVICE_SEND_SECRET` and appears in `LINE_SEND_ALLOWED_NODE_IDS`; line-service accepts only sends bound to a durable notification outbox row. Web-api receives only the separate LINE admin/status secret. Public `/health` and `/ready` remain available on every HTTP surface for process and readiness checks.

When `LINE_SERVICE_URL` is configured, the web API's authenticated `/api/line-bot/*` routes proxy through the split `line-service` instead of loading local LINEJS state. Local LINEJS fallback is development/test-only. Production `SPX_ROLE=notifier` fails startup without `LINE_SERVICE_URL`, and the current trusted rollout accepts only the split topology.

Only the web API/dashboard service should be published publicly. Keep notification, LINE, OCR, and realtime service ports on the internal Docker network unless an operator explicitly exposes them on a private admin network.

## DB-First Settings

Operator settings such as `POLL_INTERVAL_MS`, `API_URL`, `AUTO_ACCEPT_ENABLED`, notification behavior, and dashboard auth signing secrets are stored in `app_settings`. Per-node HMAC keys, peer URLs, and OCR provider controls remain process-local and are never written through Settings UI.

Important DB-first keys include:

| Setting                                                                                      | Purpose                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `API_URL`, `APP_NAME`, `REFERER`                                                             | SPX upstream request shape               |
| `POLL_INTERVAL_MS`, `FETCH_DETAILS`, `SAVE_TO_DB`, `AUTO_ACCEPT_ENABLED`                     | Polling and auto-accept behavior         |
| `JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_*`, `HTTP_ALLOWED_ORIGINS`, `HTTP_TRUST_PROXY`         | Dashboard auth and HTTP runtime settings |
| `NOTIFIER_AUTH_MODE`                                                                          | Legacy dev-only internal API auth mode   |
| `NOTIFIER_REQUEST_TIMEOUT_MS`, `NOTIFIER_RETRY_MAX_ATTEMPTS`, `NOTIFIER_RETRY_BASE_DELAY_MS` | Worker publish timeout/retry behavior    |
| `LINE_CHANNEL_ACCESS_TOKEN`, `LINEJS_*`, `DISCORD_WEBHOOK_URL`                               | Notification providers                   |
| `LINE_IMAGE_LISTENER_CHAT_ID`                                                               | LINE image/OCR integration               |

Process identity keys such as `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, split LINE/OCR routing, `CODEX_IMAGE_*`, `REALTIME_*` routing/auth, and all `AUTO_ACCEPT_JOB_*` worker/cutover controls are intentionally not DB-first keys. They are process-local so each role can keep its own identity, team assignment, internal peer URLs, per-node credentials, headless loop selection, and bounded peer-call timeouts without mutating shared `app_settings`.

Team-scoped SPX credentials and LINE targets are stored encrypted on each `teams` row. Do not keep `COOKIE`, `DEVICE_ID`, `LINE_USER_ID`, or auto-accept success/failure LINE targets as global runtime env after migration.

Before removing legacy runtime values from production `.env`, deploy the DB-first build once with the old `.env` still present. Startup seeds missing `app_settings` rows from env, then later boots can run with only bootstrap/process env.

## Protected Workflow Variables And Secrets

The protected evidence producer chain uses GitHub repository variables (`vars.*`) and secrets (`secrets.*`) only. They are never read by the application runtime, never stored in `app_settings`, and must never contain values in this document. All `*_SHA`/`*_SHA256` pins hold reviewed commit or file digests; replacing the coordinated all-zero bootstrap values follows the Stage A/B/C sequence in [[deployment]].

| Group | Names | Purpose |
| --- | --- | --- |
| Trusted producer pins | `SPX_TRUSTED_RELEASE_WORKFLOW_SHA`, `SPX_TRUSTED_STAGING_SIGNER_SHA`, `SPX_TRUSTED_STAGING_PROTECTED_EVIDENCE_WORKFLOW_SHA`, `SPX_TRUSTED_DESCRIPTOR_SIGNER_SHA`, `SPX_TRUSTED_IDENTITY_WORKFLOW_SHA`, `SPX_TRUSTED_PRODUCTION_BACKUP_RESTORE_WORKFLOW_SHA`, `SPX_TRUSTED_DEPLOY_WORKFLOW_SHA` | Immutable commit SHA of each foundational trusted reusable workflow |
| Gate 6 signer pins | `SPX_TRUSTED_GATE6_ENVELOPE_SIGNER_SHA`, `SPX_TRUSTED_GATE6_LINE_PERMIT_SIGNER_SHA`, `SPX_TRUSTED_GATE6_OCR_PERMIT_SIGNER_SHA`, `SPX_TRUSTED_GATE6_POSTPROOF_SIGNER_SHA`, `SPX_TRUSTED_GATE6_RUNTIME_EXECUTOR_SHA`, `SPX_TRUSTED_GATE6_ACCEPTED_EVIDENCE_EXPORTER_SHA`, `SPX_TRUSTED_GATE6_FINAL_VERIFIER_EXPORTER_SHA` | Independently pinned reusable signer/exporter commit SHAs; never inferred from the candidate SHA |
| Gate 6 file/module digests | `SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_WORKFLOW_SHA256`, `SPX_GATE6_ACCEPTED_EVIDENCE_EXPORTER_MODULE_SHA256`, `SPX_GATE6_FINAL_VERIFIER_EXPORTER_WORKFLOW_SHA256`, `SPX_GATE6_FINAL_VERIFIER_EXPORTER_MODULE_SHA256` | Exact workflow-file and exporter-module byte digests |
| Gate 6 KMS key material | `SPX_GATE6_ENVELOPE_KEY_ID`, `SPX_GATE6_ENVELOPE_SIGNER_URL`, `SPX_GATE6_LINE_PERMIT_KEY_ID`, `SPX_GATE6_LINE_PERMIT_SIGNER_URL`, `SPX_GATE6_OCR_PERMIT_KEY_ID`, `SPX_GATE6_OCR_PERMIT_SIGNER_URL`, `SPX_GATE6_POSTPROOF_KEY_ID`, `SPX_GATE6_POSTPROOF_SIGNER_URL` | KMS key identifiers and signer endpoints for each signing role |
| Descriptor/target identity | `SPX_APPROVED_PRODUCTION_TOPOLOGY`, `SPX_DESCRIPTOR_KEY_ID`, `SPX_DESCRIPTOR_OIDC_AUDIENCE`, `SPX_DESCRIPTOR_PUBLIC_KEY_B64`, `SPX_DESCRIPTOR_SIGNER_URL`, `SPX_DESCRIPTOR_SIGNER_FILE_SHA256`, `SPX_DESCRIPTOR_TARGET_FACTS_B64`, `SPX_TARGET_FACTS_SHA256`, `SPX_TARGET_HOST_IDENTITY_SHA256` | Approved topology and deployment target descriptor verification material |
| Backup chain pins | `SPX_PRODUCTION_BACKUP_WORKFLOW_FILE_SHA256`, `SPX_PRODUCTION_BACKUP_CONTROLLER_SHA256`, `SPX_PRODUCTION_BACKUP_LIVE_ADAPTER_SHA256`, `SPX_PRODUCTION_BACKUP_EVIDENCE_VERIFIER_SHA256`, `SPX_PRODUCTION_BACKUP_EVIDENCE_SIGNING_KEY_ID`, `SPX_PRODUCTION_BACKUP_INVARIANTS_SHA256`, `SPX_PRODUCTION_BACKUP_ISOLATED_COMPOSE_SHA256`, `SPX_PRODUCTION_BACKUP_DOCKER_SHA256`, `SPX_PRODUCTION_BACKUP_MYSQL_SHA256`, `SPX_PRODUCTION_BACKUP_MYSQLDUMP_SHA256`, `SPX_PRODUCTION_BACKUP_MYSQL_IMAGE`, `SPX_PRODUCTION_BACKUP_KMS_ENVELOPE_SHA256`, `SPX_PRODUCTION_BACKUP_KMS_CAPABILITY_SHA256`, `SPX_PRODUCTION_BACKUP_KMS_KEY_ID`, `SPX_PRODUCTION_BACKUP_SOURCE_CREDENTIAL_SHA256`, `SPX_PRODUCTION_BACKUP_MAXIMUM_AGE_MINUTES`, `SPX_PRODUCTION_BACKUP_MAXIMUM_RPO_MINUTES`, `SPX_PRODUCTION_BACKUP_MAXIMUM_RTO_MINUTES` | Backup controller, tool, compose, KMS capability, and RPO/RTO/age bounds for pre-mutation backup evidence |
| Protected install pins | `SPX_PROTECTED_INSTALL_EVIDENCE_WORKFLOW_FILE_SHA256`, `SPX_PROTECTED_INSTALL_EVIDENCE_ASSEMBLER_SHA256`, `SPX_PROTECTED_INSTALL_EVIDENCE_SCHEMA_SHA256`, `SPX_PROTECTED_INSTALL_EVIDENCE_SIGNING_KEY_ID`, `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_SHA256` | Protected-install evidence assembly and signing pins |
| Staging capability | `SPX_STAGING_ACTION_CAPABILITY_BUNDLE_SHA256` | Digest of the signed staging action capability bundle |
| Host SSH material (secrets) | `SPX_HOST`, `SPX_PORT`, `SPX_USER`, `SPX_SSH_KEY`, `SPX_KNOWN_HOSTS` with `SPX_KNOWN_HOSTS_SHA256` (var) | Pinned SSH transport for protected evidence delivery; the known-hosts digest must match |
| Approval capability (secrets) | `SPX_PRODUCTION_IDENTITY_APPROVAL_B64`, `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_B64`, `SPX_STAGING_ACTION_CAPABILITY_BUNDLE_B64` | Operator-approved identity/capability documents consumed by trusted workflows |
| Node-scoped HMAC keys | `NOTIFICATION_NODE_SECRET`, `NOTIFICATION_NODE_SECRETS`, `NOTIFICATION_ALLOWED_NODE_TEAMS`, `OCR_NODE_SECRET`, `OCR_NODE_SECRETS`, `OCR_ALLOWED_LINE_NODE_IDS`, `OCR_ADMIN_NODE_IDS`, `LINE_SEND_ALLOWED_NODE_IDS`, `LINE_ADMIN_ALLOWED_NODE_IDS` | Process-local node keys for signed internal calls (worker→notification-service, line-service→ocr-service, web-api admin). In production the runtime does not fall back to `NOTIFIER_SHARED_SECRET` for these callers; each receiver allowlist must exactly match its node-key set, and previous node keys remain valid via `previousExpiresAt` for a 7-day rotation window |

## MySQL grant contract

`deploy/db-grants.json` is the exact table-level contract for the Compose migrator, web API, notification service, LINE service, split workers, optional realtime service, Gate 6 control plane, and one-shot Gate 6 monitor. Runtime roles have no schema DDL; the migrator is the only role allowed `CREATE`, `ALTER`, `INDEX`, or `DROP`. Application runtimes verify `schema_migrations`; narrowly scoped control/observer probes are explicitly exempt. Inbound signed-service roles have exactly `SELECT, INSERT, DELETE` on `internal_request_replays`. The Gate 6 monitor receives only three table reads and must present `MAX_USER_CONNECTIONS 1` in `SHOW GRANTS`.

Validate the contract without reading database credentials or opening a connection:

```powershell
npm run db:grants-check -- --role=migrator --dry-run
```

For a live check, omit `--dry-run` inside the selected Compose service. Live verification requires `DB_PASSWORD_FILE`, `DB_SSL_MODE=verify-identity`, and `DB_SSL_CA_FILE`. It also requires the exact non-secret MySQL account-host pattern through either `--expected-account-host` or a stable regular file named by `DB_EXPECTED_ACCOUNT_HOST_FILE`; do not use `%`. Output is sanitized JSON containing only the role, mode, and failure codes. `runtime_ddl_dependency_unresolved` means a role is not yet eligible for DML-only grants. Any host mismatch, account-resource-limit mismatch, missing required grant, cross-schema grant, global privilege, MySQL role assignment, `GRANT OPTION`, runtime DDL, or undeclared privilege fails closed. Provision each external value from the operator-approved private source host or CIDR; no address is hard-coded in the release contract.

## Validation Rules

- URLs ต้องเป็น valid URL format
- Integer fields ต้องเป็นตัวเลขตาม contract ของแต่ละค่า; ส่วนใหญ่ต้องเป็นค่าบวก แต่บางค่าอนุญาต `0` หรือค่าว่างตาม `src/config/env.ts`
- Dashboard secrets (`JWT_SECRET`, `COOKIE_SECRET`) ต้อง ≥ 32 characters
- Admin password ต้องแข็งแรงเพียงพอ
- CORS origins ต้องเป็น valid URLs
- `ADMIN_ROLE` ต้องเป็น `admin` หรือ `user`
- `REALTIME_SERVICE_URL` must be HTTP(S), contain no credentials/query/fragment, and use only `/` or `/internal/realtime`; it must be empty for `SPX_ROLE=realtime-service`
- A remote realtime client requires non-empty `SPX_NODE_ID` and `REALTIME_SHARED_SECRET`, plus a positive `REALTIME_REQUEST_TIMEOUT_MS`
- A `realtime-service` requires non-empty trusted ids and node secrets; every trusted id must have exactly one admin/team classification, and the unique per-node secret map must exactly match the trusted set
- `poller-service` and `auto-accept-service` require non-empty `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, external MySQL in production, and headless `HTTP_ENABLED=false`; an auto-accept service must enable at least one consumer loop

## ดูเพิ่มเติม

- [[architecture]] — Feature flag system
- [[deployment]] — Production .env template
- [[production-cautions]] — ข้อควรระวังเรื่อง secrets
