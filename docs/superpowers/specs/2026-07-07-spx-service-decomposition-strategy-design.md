# SPX Service Decomposition Strategy

## Status

Proposed ADR/spec. This document records the target architecture and migration strategy before implementation. It does not change runtime behavior by itself.

## Context

SPX currently runs as one npm package with split runtime roles:

- `notifier`: HTTP dashboard/API, migrations, central notification delivery, runtime metrics aggregation.
- `worker`: polling and auto-accept workers, limited by `RUN_TEAM_IDS`.
- `combined`: local/development mode that runs everything in one process.

Production already runs workers per team in separate containers. The same model can run across separate machines because each worker has a stable `SPX_NODE_ID`, a `RUN_TEAM_IDS` assignment, shared MySQL state, and DB-backed team runtime leases.

The current split is useful, but two reliability problems remain:

- External integrations such as LINEJS and OCR can fail independently from the dashboard/API but currently share process boundaries with other capabilities.
- Deploy or process restart windows can make nginx return transient 502 when the HTTP upstream is unavailable.

The desired long-term direction is service decomposition for growth: isolate high-risk runtime loops, support multi-host workers, enable per-service scaling and deploys, and keep business data consistent while the system grows.

## Decision

Adopt a staged service architecture. Keep the repository as a monorepo initially, but split runtime services behind explicit contracts.

The first production-ready target is not database-per-service microservices. The first target is a service-oriented monorepo with:

- independent deployable processes/containers;
- clear service ownership of behavior and tables;
- DB-backed outbox/queue contracts for async work;
- internal HTTP for bounded commands and status reads;
- shared MySQL while ownership boundaries mature;
- idempotency keys and leases anywhere work may be retried or distributed.

Do not move immediately to separate databases, a message broker, or Kubernetes unless operational pressure justifies them. Those remain later options after service boundaries are stable.

## ADR Clarifications

These points answer the operational questions that triggered this ADR/spec:

- A LINEJS failure should not take down the whole web app. The previous whole-site 502 risk came from LINEJS living in the same `notifier` process that also served HTTP/dashboard routes; when LINEJS listener errors restarted that process, nginx temporarily had no healthy upstream.
- LINEJS must be isolated as `line-service`. Dashboard-facing `/api/line-bot/*` routes may remain on `web-api`, but in split mode they proxy signed commands to `line-service` for status, login, groups, profile, storage health, logout, and sends.
- `notification-service` owns retry/outbox state. It calls `line-service` for LINEJS delivery and treats `line-service` failures as retryable delivery failures, not as process-fatal errors.
- Workers are already safe to run as separate processes or separate machines when each process has a unique `SPX_NODE_ID`, explicit non-overlapping `RUN_TEAM_IDS`, shared MySQL access, and DB-backed team leases.
- Phase 0/1 should not split every domain into fully independent databases. The safer growth step is runtime/service isolation first, then stronger data ownership once operational behavior is proven.

## Goals

- Allow each team worker to run on a separate machine.
- Keep dashboard/API available when LINEJS, OCR, notification delivery, or one team worker fails.
- Scale pollers, notification delivery, OCR, and realtime/dashboard independently.
- Support zero-downtime or low-downtime deploy paths per service.
- Preserve current team-scoped behavior and DB-first config.
- Make every cross-service side effect retry-safe and observable.
- Keep migration incremental enough to ship safely.

## Non-Goals

- Rewriting the app into separate repositories in the first phase.
- Moving every service to its own database immediately.
- Introducing Kafka, RabbitMQ, NATS, Kubernetes, or service mesh as mandatory first steps.
- Changing SPX auto-accept business rules as part of service decomposition.
- Removing the current `combined` local/dev mode before replacement tooling exists.

## Target Runtime Topology

```text
                 +--------------------+
Internet/Nginx ->| web-api-service    |
                 | dashboard + API    |
                 +---------+----------+
                           |
                           v
                 +--------------------+
                 | MySQL              |
                 | app_settings       |
                 | teams              |
                 | outbox/leases      |
                 | service tables     |
                 +--------------------+

 worker-node-a                         worker-node-b
+------------------+                 +------------------+
| poller-service   |                 | poller-service   |
| RUN_TEAM_IDS=1   |                 | RUN_TEAM_IDS=2   |
+--------+---------+                 +--------+---------+
         |                                    |
         v                                    v
+------------------+                 +------------------+
| auto-accept      |  async jobs or   | auto-accept      |
| service          |  internal calls  | service          |
+------------------+                 +------------------+

                 +----------------------+
                 | notification-service |
                 | outbox dispatcher    |
                 +-----+-----------+----+
                       |           |
                       v           v
              +--------------+  +----------------+
              | line-service |  | discord/lineOA |
              | LINEJS owner |  | provider calls |
              +------+-------+  +----------------+
                     |
                     v
              +-------------+
              | ocr-service |
              | image reads |
              +-------------+

                 +------------------+
                 | realtime-service |
                 | SSE + metrics    |
                 +------------------+
```

## Service Boundaries

### web-api-service

Owns:

- Dashboard/API HTTP server.
- Auth, user session, RBAC.
- Admin settings, teams, users, audit APIs.
- Read APIs for dashboard views.
- SPA static asset serving until frontend hosting is split.

Does not own:

- Long-running poll loops.
- LINEJS client/session.
- OCR execution.
- Notification dispatch loops.

Failure mode:

- If downstream services are degraded, the dashboard remains up and shows degraded status.

### poller-service

Owns:

- Polling SPX bidding list/detail data.
- One or more assigned teams using `RUN_TEAM_IDS`.
- Per-team `TeamRuntimeManager`, runtime lease acquisition, runtime status.
- Publishing detected bookings, detail snapshots, metrics, and candidate work.

Runs:

- One process can own one or many teams.
- Many machines can run poller-service as long as `SPX_NODE_ID` is unique and `RUN_TEAM_IDS` is configured.
- DB-backed leases prevent duplicate active ownership of a team.

Does not own:

- LINEJS send/listen.
- Notification delivery.
- Dashboard/API.

### auto-accept-service

Owns:

- Rule matching that leads to accept attempts.
- Accept attempt idempotency and in-flight dedupe.
- Verify-after-accept classification.
- Budget settlement and release semantics.
- Writing auto-accept outcomes.

Initial migration option:

- Keep auto-accept in worker process until poller boundaries are stable, then extract.

Required invariant:

- Every accept job must have an idempotency key such as `teamId:bookingId:requestId:ruleId:attemptKind`.

### booking-history-service

Owns:

- Write-once `spx_booking_history` persistence.
- Reconciliation/backfill jobs.
- History-specific invariants such as `unique(team_id, request_id)`.

Initial migration option:

- Keep repository code shared, but route writes through an explicit history API or queue before splitting data ownership.

### notification-service

Owns:

- `notification_outbox`.
- Delivery state machine: pending, locked, delivered, retrying, failed, dead-letter.
- Provider routing: Discord, LINE OA, LINEJS through line-service.
- Retry, backoff, local spool replay, provider result persistence.

Does not own:

- LINEJS auth/session internals.
- Polling or accept decisions.

Failure mode:

- If notification-service is down, workers and auto-accept write outbox rows and continue.
- The dashboard shows pending/failed notification counts.

### line-service

Owns all LINEJS behavior:

- LINEJS auth token/session and storage path.
- QR login/status.
- LINEJS notification send.
- LINEJS image listener.
- LINEJS reconnect/retry behavior.
- E2EE storage health.

Does not own:

- Notification outbox state.
- OCR model execution.
- Dashboard/API.

Failure mode:

- If LINEJS crashes or reconnects, only line-service restarts.
- notification-service retries LINEJS sends or falls back according to policy.
- web-api-service and poller-service remain available.

### ocr-service

Owns:

- Image download/buffering after line-service receives a LINE image event.
- Image validation and size/type checks.
- Codex/OpenAI provider execution.
- OCR timeout and retry policy.
- Persisting valid extraction output through an explicit contract.

Failure mode:

- OCR timeout/failure replies through line-service when possible.
- OCR failure does not affect dashboard/API, workers, or notification delivery.

### realtime-service

Owns:

- SSE connections and realtime fan-out.
- Runtime status aggregation.
- Metrics snapshots for dashboard views.

Initial migration option:

- Keep realtime inside web-api-service until other runtime loops are extracted.

### settings/team/auth domain

Owns:

- `app_settings` catalog and reload metadata.
- `teams` credentials and notification targets.
- user/team/RBAC configuration.

Initial migration option:

- Keep inside web-api-service. Extract only if operational ownership becomes separate.

### Runtime Config Boundary

Split runtime roles need a hard line between shared business settings and process-local boot settings:

- Keep shared operator settings in `app_settings`, such as SPX API URL, polling cadence, notification rules, and provider settings.
- Keep process-local settings in environment/compose/runtime configuration, such as `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, `LINE_SERVICE_URL`, `LINE_SERVICE_REQUEST_TIMEOUT_MS`, `OCR_SERVICE_URL`, and `OCR_SERVICE_REQUEST_TIMEOUT_MS`.
- Do not let one service process persist process-local boot settings into shared `app_settings`, because that can make another role inherit the wrong boot shape. For example, a worker must keep `HTTP_ENABLED=false`, while HTTP services need `HTTP_ENABLED=true`.
- `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, `HTTP_ENABLED`, `HTTP_PORT`, `LINE_SERVICE_URL`, `LINE_SERVICE_REQUEST_TIMEOUT_MS`, `OCR_SERVICE_URL`, and `OCR_SERVICE_REQUEST_TIMEOUT_MS` are now treated as process-local service environment rather than DB-backed Settings keys; keep the same boundary for any future split-service boot flags and peer-call client knobs.
- DB-first settings load must refresh these process-local values from the process environment before validation, while ignoring any stale rows with the same names in shared `app_settings`.

## Data Ownership

Use one MySQL database initially with table ownership conventions:

| Owner                   | Tables / table groups                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| web-api-service         | `users`, audit APIs, admin-facing read models                         |
| settings/team/auth      | `app_settings`, `teams`, auth metadata                                |
| poller-service          | `team_runtime_leases`, runtime desired state, poller status snapshots |
| auto-accept-service     | auto-accept attempts, progress, idempotency keys                      |
| booking-history-service | `spx_booking_history` and reconciliation state                        |
| notification-service    | `notification_outbox`, delivery locks, provider delivery records      |
| line-service            | `line_bot_sessions`, LINEJS storage metadata                          |
| ocr-service             | LINE image extraction records and OCR job state                       |
| realtime-service        | metrics snapshots/read models if persisted                            |

Rules:

- A service may read tables owned by another service only through an approved read model or repository boundary during the monorepo phase.
- Cross-service writes should move to APIs or outbox jobs before separate databases are considered.
- Schema migrations remain centrally ordered until service ownership and deploy sequencing are mature.

## Communication Contracts

Use two communication styles:

### Internal HTTP

Use for commands that need a bounded immediate answer:

- web-api-service -> line-service: QR login/status.
- notification-service -> line-service: send LINEJS message.
- line-service -> ocr-service: submit image for OCR, if synchronous reply is required.
- web-api-service -> realtime-service: status/read endpoints, if split.

Requirements:

- Request timeout.
- Auth via shared secret or service token.
- Request id / trace id.
- Error response shape with retryable vs non-retryable classification.

### DB-backed outbox / queue

Use for asynchronous side effects:

- poller-service publishes detected booking/detail events.
- auto-accept-service publishes notification requests.
- notification-service locks and delivers pending notification rows.
- line-service publishes incoming image events.
- ocr-service publishes extraction results.

Requirements:

- Idempotency key.
- Lock owner and lock expiry.
- Attempt count and next-at timestamp.
- Dead-letter state.
- Payload schema version.
- Trace id and source service.

## Multi-Host Workers

Workers can run on separate machines when these conditions hold:

- Each worker has `SPX_ROLE=worker`.
- Each worker has a unique `SPX_NODE_ID`.
- Each worker has explicit `RUN_TEAM_IDS`.
- All workers connect to the same MySQL database.
- All workers can reach the notifier or notification-service endpoint.
- `NOTIFIER_SHARED_SECRET` or replacement service token is shared correctly.
- All workers run compatible code and migration versions.
- Each worker has its own local spool path if local spool is enabled.

Example:

```text
machine-a:
  SPX_ROLE=worker
  SPX_NODE_ID=prod-worker-team-1-a
  RUN_TEAM_IDS=1

machine-b:
  SPX_ROLE=worker
  SPX_NODE_ID=prod-worker-team-2-a
  RUN_TEAM_IDS=2

machine-c:
  SPX_ROLE=notifier
  SPX_NODE_ID=prod-notifier-1
```

The DB lease remains the guardrail against duplicate active team ownership. Operators should still avoid duplicate `RUN_TEAM_IDS` assignments unless intentionally testing failover.

## Delivery Semantics

### Notifications

- Auto-accept and poller workflows write notification requests to outbox.
- notification-service owns retry and final status.
- LINEJS sends go through line-service.
- If line-service is unavailable, notification-service retries or falls back according to provider policy.
- Discord/LINE OA can be fallback providers when LINEJS fails.

### LINE image OCR

- line-service receives LINE image events.
- line-service records an image event and submits OCR work.
- ocr-service downloads/validates/processes image content.
- ocr-service stores extraction result.
- line-service replies to the LINE chat when result or timeout is known.
- OCR failure must not crash line-service; line-service remains responsible for listener reconnect.

### Auto-accept

- Accept attempts must be idempotent.
- Ambiguous timeout outcomes must not release business claims until verifier classification says it is safe.
- Verification writes canonical outcome before notification.
- Notification failures never change the accept result.

## Deployment Strategy

### Phase 0: Prepare Contracts

- Document service boundaries and table ownership.
- Add trace id propagation.
- Standardize internal service auth.
- Standardize outbox lock/retry/dead-letter columns.
- Add service health/readiness shape.

### Phase 1: Extract LINEJS/OCR/Notification Boundary

- Create line-service as the single LINEJS owner.
- Move LINEJS send and image listener into line-service.
- Create ocr-service or isolated OCR worker.
- Ensure notification-service calls line-service rather than importing LINEJS code.
- Keep fallback providers available.

This phase directly reduces the blast radius from LINEJS/OCR failures.

### Phase 2: Harden Multi-Host Workers

- Document per-machine worker deployment.
- Verify `RUN_TEAM_IDS`, unique `SPX_NODE_ID`, DB leases, and notifier connectivity.
- Add dashboard visibility for lease owner, machine/node id, and last heartbeat.
- Make worker deploys independent from web-api deploys.

### Phase 3: Extract Poller and Auto-Accept

- Keep poller-service per team or per assigned team group.
- Move auto-accept into its own service only after idempotency and queue contracts are explicit.
- Ensure booking history and auto-accept history writes remain consistent.

### Phase 4: Split Realtime and Read Models

- Move SSE/runtime metrics aggregation into realtime-service if dashboard load requires it.
- Add read models for dashboard views if direct operational tables become expensive.

### Phase 5: Optional Stronger Isolation

Consider separate databases, broker adoption, or orchestration only after:

- service contracts have stabilized;
- outbox queues show clear throughput pressure;
- operational tooling can handle distributed tracing and deploy coordination;
- the team has a real need for independent scaling or ownership.

## Observability

Every service must log:

- `service`
- `nodeId`
- `teamId` when applicable
- `traceId`
- `jobId` / idempotency key for async work
- provider name for external calls
- retry attempt and classification

Minimum dashboards:

- service health/readiness;
- queue depth by outbox type;
- dead-letter count;
- LINEJS auth/listener state;
- OCR latency and timeout count;
- worker lease owner per team;
- notification delivery success/failure by provider;
- deploy version per service.

## Security

- Internal service endpoints require service auth.
- `NOTIFIER_SHARED_SECRET` can evolve into per-service tokens or mTLS later.
- Raw SPX cookies, device IDs, LINE targets, auth tokens, and LINEJS storage values must never be returned in API responses or logs.
- Each service receives only the secrets it needs.
- line-service owns LINEJS secrets; web-api-service should not directly access LINEJS storage after extraction.
- Worker machines must not expose dashboard/API ports publicly.

## Failure Handling

| Failure                        | Expected behavior                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| line-service crashes           | LINEJS send/listen unavailable; dashboard/API/workers continue; notification-service retries or falls back |
| OCR times out                  | image reply reports timeout if possible; OCR job marked failed/retryable according to classification       |
| notification-service down      | outbox rows accumulate; poller/auto-accept continue                                                        |
| one team worker down           | only assigned teams on that worker stop; leases expire and can be acquired by another configured worker    |
| web-api-service deploy restart | workers continue polling; dashboard temporarily unavailable unless zero-downtime deploy is in place        |
| MySQL down                     | most services degrade or stop; this remains the shared critical dependency in the first target             |

## Acceptance Criteria

- A LINEJS crash cannot make web-api-service return nginx 502.
- A LINEJS crash cannot stop poller-service or auto-accept-service.
- One team's worker can run on a separate machine from another team's worker.
- Two workers accidentally assigned to the same team do not both run active pollers because DB lease ownership prevents it.
- Notification delivery is retryable and observable through outbox state.
- Dashboard can show degraded service status instead of failing wholesale when LINEJS/OCR/notification services are down.
- Secrets remain redacted in logs and API responses.
- Production can still run in a simpler single-host topology during migration.

## Testing Plan

### Documentation and Static Checks

- Review this spec against `docs/architecture.md`, `docs/deployment.md`, and `docs/env-reference.md`.
- Add or update ADR references when implementation begins.

### Service Contract Tests

- Internal HTTP endpoints reject missing/invalid service auth.
- Internal HTTP endpoints return retryable/non-retryable error classification.
- Outbox locking prevents two dispatchers from delivering the same job.
- Idempotency keys prevent duplicate accept and notification side effects.

### Runtime Tests

- worker A with `RUN_TEAM_IDS=1` starts only team 1.
- worker B with `RUN_TEAM_IDS=2` starts only team 2.
- duplicate team assignment results in one active lease owner.
- lease expiry allows a replacement worker to acquire the team.
- notification-service down does not stop poller-service.
- line-service down does not stop web-api-service.

### Production Verification

- `npm run typecheck`
- `npm run build`
- service health checks return expected status.
- public dashboard stays available while line-service is manually restarted.
- worker runtime metrics keep flowing while notification-service is restarted.
- notification outbox drains after service recovery.

## Phase 0/1 Decisions

The initial implementation plan resolved the open questions for the first rollout slice:

- Phase 1 implements `line-service` and `ocr-service` as explicit runtime roles and HTTP surfaces. OCR keeps local fallback during migration so line-service can still process images when `OCR_SERVICE_URL` is unset.
- `notification-service` owns dispatch from the notification outbox and routes LINEJS delivery through `line-service`. Legacy `notifier` keeps local fallback until production migration is verified.
- The first production topology is one host with multiple containers. Multi-host workers remain supported through unique `SPX_NODE_ID`, explicit `RUN_TEAM_IDS`, shared MySQL, and DB leases.
- Failover remains manual at first. Operators should keep `RUN_TEAM_IDS` explicit and non-overlapping by default; overlapping assignments are reserved for deliberate failover testing.

## Final Recommendation

Use a staged service decomposition:

1. Extract LINEJS, OCR, and notification delivery first.
2. Harden multi-host team workers using the existing `RUN_TEAM_IDS` and DB lease model.
3. Extract poller/auto-accept/history boundaries only after async contracts and idempotency are explicit.
4. Keep one database and one repository until operational tooling catches up.

This gives SPX the growth path of microservices without paying the full distributed-systems cost before the service contracts are ready.
