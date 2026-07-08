---
title: Deployment
tags:
  - obsidian
  - spx
  - deployment
  - docker
aliases:
  - การ Deploy
  - Production Setup
---

# Deployment

## Local Run

```bash
npm install
npm run build       # backend (esbuild) + frontend (vite) → dist/
npm start -- 10     # start with 10s interval
```

> [!note] Frontend Build
> `npm run build` จะสร้างทั้ง backend (`dist/app.js`) และ frontend (`dist/public/index.html` + assets)
> Backend จะ serve SPA จาก `dist/public/` โดยอัตโนมัติเมื่อ `HTTP_ENABLED=true`

> [!important] Database Migrations
> ถ้า `HTTP_ENABLED=true` หรือ `SAVE_TO_DB=true` ต้อง run migration ก่อน startup:
>
> ```bash
> npm run db:migrate
> ```
>
> แต่ระบบมี runtime `CREATE TABLE IF NOT EXISTS` เป็น safety net อยู่แล้ว

## Development Mode

```bash
# Backend only (ts-node)
npm run dev:backend -- 10

# Frontend only (Vite dev server with proxy)
npm run dev:frontend

# Both backend + frontend (concurrently)
npm run dev
```

## Smoke Test

```bash
npm run smoke:test
```

> [!note] ต้อง start app ก่อน
> Smoke test ต้องการ app ที่ทำงานอยู่บน `http://127.0.0.1:3000`
> ตรวจ `/ready` และ static assets

## Docker

```bash
docker compose up --build
```

### Docker Image Details

- ==Multi-stage build== — runtime image มีแค่ built output
- Image metadata exposes the split-service HTTP ports: `3000`, `3002`, `3003`, and `3004`
- Healthcheck ยิง `GET /ready` อัตโนมัติที่ `HTTP_PORT` ของ process นั้น
- Base image: `node:24-alpine`
- `.dockerignore` excludes local `.env`, runtime data, logs, memory notes, and local tool state from the Docker build context. Runtime bootstrap values still come from Compose `env_file`/bind mounts, not from files baked into the image.

### Legacy Production Services

Default production compose still runs one shared image as three legacy-compatible services:

| Service       | Role                                | Responsibility                                                                                            |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `notifier`    | `SPX_ROLE=notifier`                 | HTTP/dashboard, migrations, internal notification API, central LINE delivery, runtime metrics aggregation |
| `worker-ifn`  | `SPX_ROLE=worker`, `RUN_TEAM_IDS=2` | IFN polling/auto-accept worker                                                                            |
| `worker-ptwl` | `SPX_ROLE=worker`, `RUN_TEAM_IDS=1` | PTWL polling/auto-accept worker                                                                           |

Workers call the notifier over Docker networking. Notification events use `/internal/notification-events`; runtime telemetry uses `/internal/runtime-metrics`.

### Split-Service Topology (Optional)

`docker-compose.yml` also defines optional `profile: split` services for the service-decomposition migration. CI deploys the legacy topology by default on `main` pushes; after Task 9 drill evidence is recorded, operators can explicitly choose `deploy_topology=split` from `workflow_dispatch`. For a manual cutover, stop legacy services first, provide per-cutover `LINE_SERVICE_SEND_SECRET` only to `web-api`, `notification-service`, and `line-service`, provide `LINE_SERVICE_ADMIN_SECRET` only to `web-api` and `line-service`, then start split services by naming them explicitly so the legacy `notifier`, `worker-ifn`, and `worker-ptwl` services do not start alongside the split workers:

```bash
docker compose stop notifier worker-ifn worker-ptwl
export LINE_SERVICE_ADMIN_SECRET="$(cat /proc/sys/kernel/random/uuid)$(cat /proc/sys/kernel/random/uuid)"
export LINE_SERVICE_SEND_SECRET="$(cat /proc/sys/kernel/random/uuid)$(cat /proc/sys/kernel/random/uuid)"
docker compose --profile split up --build -d \
  web-api notification-service line-service ocr-service \
  worker-ifn-split worker-ptwl-split
```

Target single-host topology:

| Service                | Role                                              | Port Exposure                 | Notes                                                                                                    |
| ---------------------- | ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `web-api`              | `SPX_ROLE=api`, `HTTP_PORT=3000`                  | Published on `127.0.0.1:3000` | Runs migrations, dashboard, API, health/readiness                                                        |
| `notification-service` | `SPX_ROLE=notification-service`, `HTTP_PORT=3002` | Internal Docker network only  | Accepts worker notification events and dispatches outbox via `LINE_SERVICE_URL=http://line-service:3003` |
| `line-service`         | `SPX_ROLE=line-service`, `HTTP_PORT=3003`         | Internal Docker network only  | Owns LINEJS send/status/listener and calls `OCR_SERVICE_URL=http://ocr-service:3004` when configured     |
| `ocr-service`          | `SPX_ROLE=ocr-service`, `HTTP_PORT=3004`          | Internal Docker network only  | Owns Codex image OCR provider work                                                                       |
| `worker-ifn-split`     | `SPX_ROLE=worker`, `RUN_TEAM_IDS=2`               | none                          | Publishes to `http://notification-service:3002/internal/notification-events`                             |
| `worker-ptwl-split`    | `SPX_ROLE=worker`, `RUN_TEAM_IDS=1`               | none                          | Publishes to `http://notification-service:3002/internal/notification-events`                             |

Only `web-api` should be published through nginx/public ports. Keep `notification-service`, `line-service`, and `ocr-service` on internal Docker network ports unless an operator intentionally exposes them for a private admin network.

`SPX_NODE_ID` must be unique for every running service process and every worker machine. Keep `RUN_TEAM_IDS` explicit and non-overlapping by default; do not run two workers for the same team unless lease/failover behavior is being deliberately tested. `LINE_SERVICE_SEND_SECRET` is process-local credential material for notification-service-to-line-service sends and authenticated web-api-to-line-service manual sends; do not expose it to workers. `LINE_SERVICE_ADMIN_SECRET` is process-local credential material for web-api-to-line-service admin/status routes; do not store either split secret in DB-backed `app_settings`.

Rollback path:

1. Stop split containers: `docker compose --profile split stop web-api notification-service line-service ocr-service worker-ifn-split worker-ptwl-split`.
2. Start legacy services: `docker compose up -d notifier worker-ifn worker-ptwl`.
3. Confirm workers point back to `NOTIFIER_API_URL=http://notifier:3000/internal/notification-events`.
4. Confirm `curl -s http://127.0.0.1:3000/ready` returns `ready: true`.

### Split-Service Fault-Injection Drill

Run this in staging or during a supervised production migration window before selecting `deploy_topology=split` or making split services the default topology.

Read-only host probe for the public web API:

```bash
node scripts/service-fault-check.mjs --help
npm run service:fault-check -- --web-api-url=http://127.0.0.1:3000
```

Read-only internal probe from inside the Docker network:

```bash
docker compose --profile split exec -T web-api sh -lc '
  node scripts/service-fault-check.mjs --help
'
```

```bash
docker compose --profile split exec -T web-api sh -lc '
  WEB_API_URL=http://web-api:3000 \
  NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
  LINE_SERVICE_URL=http://line-service:3003 \
  OCR_SERVICE_URL=http://ocr-service:3004 \
  node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service
'
```

`--help` prints the read-only probe options without calling `/health` or `/ready`. Use the internal probe for `notification-service`, `line-service`, and `ocr-service` because they are intentionally not published to the host. The `--require` list prevents a false-positive drill if one of the internal service URLs is missing from the probe environment. Keep the JSON output from each probe as drill evidence; it records `requiredServices`, `allowedDownServices`, `allowedDegradedServices`, `expectedDownServices`, `unknownServiceNames`, `missingRequiredServices`, `missingExpectedDownServices`, `expectedDownStillReachableServices`, `unexpectedFailures`, and sanitized service URLs/status payloads. `--allow-degraded=<service>` means that service must still pass `/health` and must fail `/ready` because an expected downstream dependency is unavailable. Avoid full `docker compose config` output during the drill; it can expand env-file values. Use `docker compose --profile split config --services` only when service-name validation is needed.

For expected-down evidence, the probe options must match the runbook exactly: `allowedDownServices` must be empty, `expectedDownServices` must contain only the stopped service, and `allowedDegradedServices` must contain only the explicitly allowed downstream service for that step. `missingRequiredServices` must also be empty. The stopped service row must be present and down, allowed degraded service rows must be present and degraded, and every other required service row must be present and healthy.

Manual drill:

1. Start `web-api`, `notification-service`, `line-service`, `ocr-service`, and one split worker.
2. Confirm web API `/health` and `/ready` return success.
3. Confirm notification-service `/ready` is healthy when line-service is reachable.
4. Publish one controlled staging notification event and record its `eventKey`. This creates a real `notification_outbox` row and may send one LINE notification when the dispatcher is running, so use a staging team id or a supervised production drill target:

   Preflight the exact routing config first without sending the notification:

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs --help
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id=<staging-team-id> \
       --node-id=<allowed-worker-node-id> \
       --drill-id=<drill-id> \
       --dry-run
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id=<staging-team-id> \
       --node-id=<allowed-worker-node-id> \
       --drill-id=<drill-id> \
       --confirm-send-test-notification
   '
   ```

   `--help` prints the publisher safety contract without reading drill config or sending a request. The dry run validates required config, endpoint normalization, team id, node id, and concrete drill id without creating a request, outbox row, or LINE notification. The real publisher signs the request with HMAC using `NOTIFIER_SHARED_SECRET` from the process environment or the encrypted DB-backed `app_settings` row, and prints only safe evidence such as `drillId`, `eventKey`, HTTP status, duplicate status, outbox id, and outbox status. If node/team publishing restrictions are enabled, `--node-id` must be allowed to publish for the selected team. The evidence checker requires publish outputs to be non-duplicate, to include a positive `outboxId` plus non-empty `outboxStatus`, and to use event keys bound to the same concrete `drillId`.

5. Confirm the event is visible in aggregate outbox evidence without printing targets or message bodies:

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-outbox-check.mjs --help
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from previous step>" \
     node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from previous step>" \
     node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0
   '
   ```

   `--help` prints the read-only outbox evidence contract without reading DB env or querying MySQL. The outbox dry run validates DB env presence, the 30-minute window, expectation flags, and event-key hash binding without querying MySQL; it refuses dry-run/live checks that omit `--event-key-contains`, and it is not final evidence because final evidence must use `mode: "mysql"`. The real outbox checker does not echo the raw event key filter. It performs an exact `event_key` lookup, emits `filters.eventKeyContainsSha256`, and the evidence checker compares that hash with the publisher `eventKey` so the outbox proof is tied to the same drill event. Keep the outbox command flags exactly as shown; all outbox evidence must use `--since-minutes=30`, baseline sent evidence must include `--min-total=1 --expect-sent --max-pending=0`, and recovery sent evidence must include `--min-total=1 --expect-sent --expect-failed-attempt --max-pending=0`. If dispatch is still pending, wait a bounded interval and re-run the same read-only outbox command instead of republishing the notification.

6. Stop line-service: `docker compose --profile split stop line-service`.
7. Confirm web API still returns success: `curl -s http://127.0.0.1:3000/health`.
8. Probe from inside the Docker network with intentional LINE outage allowed:

   ```bash
   docker compose --profile split exec -T web-api sh -lc '
     WEB_API_URL=http://web-api:3000 \
     NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
     LINE_SERVICE_URL=http://line-service:3003 \
     OCR_SERVICE_URL=http://ocr-service:3004 \
     node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service --expect-down=line-service --allow-degraded=notification-service
   '
   ```

9. Publish another controlled notification event while line-service is stopped, then confirm notification outbox failures are retryable rather than process crashes:

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs --help
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id=<staging-team-id> \
       --node-id=<allowed-worker-node-id> \
       --drill-id=<drill-id> \
       --dry-run
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id=<staging-team-id> \
       --node-id=<allowed-worker-node-id> \
       --drill-id=<drill-id> \
       --confirm-send-test-notification
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from outage publish step>" \
     node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-failed-attempt
   '
   ```

   ```bash
   docker compose --profile split exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from outage publish step>" \
     node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-failed-attempt
   '
   ```

10. Confirm the split worker remains alive with `docker compose --profile split ps worker-ifn-split worker-ptwl-split`; only the intentionally stopped service should be exited, and `notification-service` may report unhealthy while `/ready` is degraded by the expected downstream LINE outage.
11. Restart line-service: `docker compose --profile split start line-service`, then confirm notification outbox drains after recovery:

    ```bash
    docker compose --profile split exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0
    '
    ```

    ```bash
    docker compose --profile split exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0
    '
    ```

    Recovery can be delayed by retry backoff. If the first read-only recovery check still shows a pending retryable row, wait a bounded interval and re-run the same command; do not publish a replacement event for recovery evidence.

12. Stop ocr-service: `docker compose --profile split stop ocr-service`.
13. Probe from inside the Docker network with expected OCR outage:

    ```bash
    docker compose --profile split exec -T web-api sh -lc '
      WEB_API_URL=http://web-api:3000 \
      NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
      LINE_SERVICE_URL=http://line-service:3003 \
      OCR_SERVICE_URL=http://ocr-service:3004 \
      node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service --expect-down=ocr-service
    '
    ```

14. Confirm line-service stays alive and LINE image OCR failures produce reply/error behavior instead of crashing.
15. Restart ocr-service: `docker compose --profile split start ocr-service`, then confirm new OCR reads succeed.

Expected result: web API remains available while line-service or ocr-service is stopped; workers keep polling or remain independently healthy; notification/OCR failures are recorded or replied as degraded behavior rather than process-wide crashes.

Optional final evidence gate:

```bash
node scripts/service-fault-evidence-check.mjs --template > fault-drill-evidence.json
```

Paste the full sanitized JSON output from each drill command into the matching key. Keep each script output's `checkedAt` value; the evidence checker verifies drill order from these timestamps and fails if the baseline, outage, recovery, and OCR probes are out of sequence or future-dated beyond a small clock-skew allowance. Do not paste raw logs, request payloads, response bodies, stdout/stderr captures, LINE targets, tokens, or secrets into evidence files; the checker rejects common unsafe fields and secret-like key variants such as `raw`, `payload`, `targetId`, `lineTargetId`, `stdout`, `stderr`, `accessToken`, `authorizationHeader`, and `sharedSecretValue`.

Set top-level rollout metadata before pasting step evidence: `drillId` must be a concrete unique id such as `split-service-fault-drill-20260707-1000`, not the scaffold placeholder `split-service-fault-drill-YYYYMMDD-HHMM`, and `environment` must be `staging` or `supervised-production`. Use the same concrete `drillId` in every `service-fault-publish-notification.mjs --drill-id=...` command. Local Docker drills remain useful confidence checks, but the final evidence checker intentionally rejects placeholder drill ids and `environment: "local"` so local-only or scaffold evidence cannot be mistaken for rollout evidence.

For `baselineProbe`, use the initial `--require=...` command without `--allow-down`, `--allow-degraded`, or `--expect-down`. For `lineDownProbe` and `ocrDownProbe`, keep the full sanitized `services` list including each row's internal Docker URL: `http://web-api:3000/`, `http://notification-service:3002/`, `http://line-service:3003/`, and `http://ocr-service:3004/`. The evidence checker rejects probes when option arrays differ from the runbook command, when `missingRequiredServices` is non-empty, when the expected-down service row is absent, when any service that should remain healthy is missing from the service rows, or when a service row points at a host/port outside the split-service Docker network.

For outbox evidence, keep the command flags exactly as shown. `baselineOutbox`, `lineDownOutbox`, and `lineRecoveryOutbox` must all include `sinceMinutes: 30` from the runbook `--since-minutes=30` lookup window and must be bound to the matching publisher output with `--event-key-contains=<eventKey>`, which performs an exact `event_key` lookup while hashing the filter in the output. `baselineOutbox` must prove `--min-total=1 --expect-sent --max-pending=0` with no retried rows. `lineDownOutbox` must prove `--min-total=1 --expect-failed-attempt` and still show at least one pending retryable row before line-service is restarted. `lineRecoveryOutbox` must prove `--min-total=1 --expect-sent --expect-failed-attempt --max-pending=0` so recovery evidence is tied to the same previously failed outage notification after it drains. All outbox evidence must have `mode: "mysql"` plus empty `missingDbEnv` and `expectationFailures` arrays; fixture-mode outbox output is useful for script tests only and is rejected by the final evidence checker.

For publish evidence, keep the full sanitized publisher output. Both `baselinePublish` and `lineDownPublish` must show `url: "http://notification-service:3002/internal/notification-events"`, the same positive `teamId`, the same non-empty `nodeId`, a concrete non-placeholder `eventKey` beginning with `fault_drill:notifier_health:team:<teamId>:drill:<drillId>:`, `duplicate: false`, a positive `outboxId`, and a non-empty `outboxStatus`; replayed duplicate publish output, scaffold event keys, cross-team publish output, event keys from a different drill id, or legacy notifier/web-api publish output is rejected.

- `baselineProbe`: initial `service-fault-check.mjs --require=...`
- `workerBaseline`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "worker-running", "note": "..." }` after `docker compose ps` or logs prove one split worker is running before the baseline publish
- `baselinePublish`: first `service-fault-publish-notification.mjs`
- `baselineOutbox`: first `service-fault-outbox-check.mjs`
- `lineDownProbe`: `service-fault-check.mjs --expect-down=line-service --allow-degraded=notification-service`
- `lineDownPublish`: outage publish command
- `lineDownOutbox`: outage outbox check
- `workerAlive`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "worker-alive", "note": "..." }` after `docker compose ps` or logs prove worker stayed alive
- `lineRecoveryOutbox`: post-restart outbox check
- `ocrDownProbe`: `service-fault-check.mjs --expect-down=ocr-service`
- `ocrFailureObserved`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "ocr-failure-observed", "note": "..." }` after LINE OCR degraded/failure behavior is observed
- `ocrRecoveryObserved`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "ocr-recovery-observed", "note": "..." }` after a new OCR request succeeds

Use UTC ISO timestamps from the moment each manual observation was made, and do not pre-fill future timestamps. The evidence checker verifies that baseline worker evidence happens before the baseline publish, worker outage evidence happens after the line-service outage/outbox failure and before line-service recovery, and OCR failure/recovery evidence happens after the ocr-service outage in drill order.

Then validate the evidence bundle:

```bash
node scripts/service-fault-evidence-check.mjs --file=fault-drill-evidence.json
```

For a live drill, it is often easier to collect each command output as a separate file and let the checker assemble the bundle:

```bash
node scripts/service-fault-evidence-check.mjs --help
node scripts/service-fault-evidence-check.mjs --init-dir=fault-drill-evidence
node scripts/service-fault-evidence-check.mjs --dir-manifest
```

`--help` prints the safe Task 9 evidence flow without evidence placeholders or raw values. `--init-dir` creates the exact per-step evidence files from the checker template and refuses to run if the target directory already contains files, so existing operator evidence is not overwritten. Replace each placeholder file with the matching sanitized command output from the manifest, for example `baseline-probe.json`, `baseline-publish.json`, `line-down-outbox.json`, and `ocr-down-probe.json`. Update `drill-metadata.json` with the real rollout metadata, for example `{ "drillId": "split-service-fault-drill-20260707-1000", "environment": "staging", "note": "..." }`; leaving the scaffold `YYYYMMDD-HHMM` placeholder in `drillId` fails `drillMetadata`. For the four manual checks, write a minimal timestamped JSON object with the required `evidenceType`, such as `{ "ok": true, "checkedAt": "2026-07-07T10:06:00.000Z", "evidenceType": "worker-alive", "note": "worker stayed alive during line-service outage" }` to:

- `worker-baseline.json`
- `worker-alive.json`
- `ocr-failure-observed.json`
- `ocr-recovery-observed.json`

While collecting evidence, check directory readiness without echoing evidence contents:

```bash
node scripts/service-fault-evidence-check.mjs --dir-status=fault-drill-evidence
```

`--dir-status` reports only filename/key readiness metadata: missing files, invalid JSON files, placeholder files, ready counts, and `nextRequiredEvidence` for the next file/key to fix in drill order. Once every evidence file is structurally ready, it also reports `semanticStatus` with pass/fail counts and failed check names so operators can correct evidence before the final `--dir` validation. It intentionally does not print raw command output, event keys, notes, LINE targets, payloads, or secrets.

Then validate the evidence directory:

```bash
node scripts/service-fault-evidence-check.mjs --dir=fault-drill-evidence
```

The evidence checker is read-only and prints only checklist pass/fail metadata. It does not echo raw evidence values, and it rejects evidence objects that still contain common unsafe raw fields.

The evidence checker also requires the baseline publish and line-outage publish to use distinct `eventKey` values. Outbox checks are hash-bound to their matching publisher output: `baselineOutbox` must match `baselinePublish`, while both `lineDownOutbox` and `lineRecoveryOutbox` must match `lineDownPublish`. Outbox evidence with fixture mode, missing or broader-than-runbook lookup windows, missing DB configuration, expectation failures, mismatched expectation flags, missing rollout metadata, or local-only metadata is rejected even if aggregate counts look plausible.

`service-fault-publish-notification.mjs` is intentionally mutating and requires `--confirm-send-test-notification`; use it only in staging or a supervised production drill. `service-fault-outbox-check.mjs` is read-only. It prints aggregate `notification_outbox` counts, expectation failures, and a SHA-256 hash of the event-key filter only; it does not print notification targets, message bodies, payload JSON, DB credentials, raw event-key filters, or raw error text.

## DB-first config

Production loads config from MySQL `app_settings` after reading bootstrap env. `.env` should contain only bootstrap values such as `NODE_ENV`, `DB_MODE`, database connection fields, and `SECRETS_KEY`. Docker/service environment should keep process identity values such as `SPX_ROLE`, `SPX_NODE_ID`, `SPX_NODE_NAME`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFIER_LOCAL_SPOOL_PATH`, and `HTTP_PORT`.

Use the dashboard Settings and Teams pages to change SPX API, polling, auto-accept, notification, auth signing secrets, provider settings, and team credentials. Before reducing `.env`, deploy the DB-first build once with the existing `.env` so startup can seed missing `app_settings` rows. Verify `/ready`, worker healthchecks, and Settings page values. After that verification, remove runtime/operator values from `.env`.

Current production has completed that rollout: `.env` should stay bootstrap-only, runtime/operator settings should come from `app_settings`, and team credentials/LINE targets should come from encrypted `teams` fields.

## Post-Deploy Verification

Use read-only checks and avoid printing secret values:

```bash
git rev-parse --short HEAD
docker compose ps
curl -s http://127.0.0.1:3000/ready
docker compose logs --since=5m notifier | grep -c 'POST /internal/runtime-metrics 200'
docker compose logs --since=5m worker-ifn worker-ptwl | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid'
npm run schema:verify
```

For split topology, check the explicit split service set and notification-service metrics logs instead of legacy notifier logs:

```bash
git rev-parse --short HEAD
docker compose --profile split ps web-api notification-service line-service ocr-service worker-ifn-split worker-ptwl-split
curl -s http://127.0.0.1:3000/ready
docker compose --profile split logs --since=5m notification-service | grep -c 'POST /internal/runtime-metrics 200'
docker compose --profile split logs --since=5m worker-ifn-split worker-ptwl-split | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid'
npm run schema:verify
```

Expected runtime state:

- Legacy: `notifier`, `worker-ifn`, and `worker-ptwl` are running and healthy.
- Split: `web-api`, `notification-service`, `line-service`, `ocr-service`, `worker-ifn-split`, and `worker-ptwl-split` are running; only `web-api` is public.
- `/ready` returns HTTP 200 with `ready: true`.
- `POST /internal/runtime-metrics 200` appears frequently in the legacy `notifier` logs or split `notification-service` logs.
- Worker logs have zero runtime-metrics publish/url failures.
- Admin Pipeline telemetry should update after the next worker metrics publish cycle; hard-refresh the dashboard if the browser still has stale UI state.

## Production Checklist

> [!warning] สิ่งที่ต้องทำก่อน deploy production

- [ ] ตั้งค่า `.env` เฉพาะ bootstrap values และตั้ง process identity values ใน Docker/service environment (ดู [[env-reference]])
- [ ] ใช้ process manager (PM2, systemd, Docker restart policy)
- [ ] Run `npm run db:migrate` ก่อน startup
- [ ] ตั้ง `HTTP_ALLOWED_ORIGINS` ผ่าน Settings สำหรับ non-localhost domain
- [ ] ตั้ง `NODE_ENV=production` สำหรับ secure cookies
- [ ] Runtime/operator secrets ต้องอยู่ใน `app_settings` หรือ team encrypted fields หลัง seed สำเร็จ
- [ ] Monitor `/health`, `/ready`, `/metrics` ผ่าน Uptime Kuma หรือ Datadog
- [ ] Verify the notifier/notification-service receives worker runtime metrics (`POST /internal/runtime-metrics 200`) after deploy
- [ ] `notify-rules.json` ต้องมี controlled write access เฉพาะ local/dev fallback; production rules อยู่ใน DB
- [ ] ตรวจว่า `npm run build` ผ่านก่อน release (includes typecheck + frontend build)
- [ ] ตรวจว่า `dist/public/` มี `index.html` และ assets ครบ

## Process Manager

> [!tip] Settings reload behavior
> Settings API เขียน DB แล้ว sync กลับเข้า process env ตาม metadata ของแต่ละ key: บางค่าเป็น live reload, บางค่าต้อง restart worker, และ security/auth/runtime binding เช่น `JWT_SECRET`, `COOKIE_SECRET`, `NOTIFIER_SHARED_SECRET`, `NOTIFIER_AUTH_MODE`, และ `HTTP_ALLOWED_ORIGINS` ต้อง restart process. `HTTP_ENABLED` เป็น process-local service env ไม่ใช่ DB-backed Settings key.
> การใช้ process manager (Docker, PM2, systemd) ยังแนะนำสำหรับ crash recovery, restart orchestration, และ availability ทั่วไป

## Frontend Build Output

```
dist/
├── app.js              # Backend bundle
├── scripts/            # CLI scripts
└── public/             # SPA static files
    ├── index.html      # React SPA entry
    └── assets/         # JS/CSS chunks (hashed)
        ├── index-xxx.js
        └── index-xxx.css
```

Backend serve ไฟล์เหล่านี้ผ่าน `@fastify/static` + catch-all route สำหรับ client-side routing

## ดูเพิ่มเติม

- [[env-reference]] — ตัวแปร environment ทั้งหมด
- [[production-cautions]] — ข้อควรระวังใน production
- [[cheatsheet]] — คำสั่ง npm ที่ใช้บ่อย
- [[architecture]] — โครงสร้างระบบ
