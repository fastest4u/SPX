# DB-First Config Design

## Goal

Make the production configuration model DB-first: operational settings, application settings, notification settings, and encrypted team credentials live in MySQL and are editable through the dashboard/API. `.env` remains only for bootstrap and process identity values that must exist before the app can connect to MySQL or know which worker role it is running.

## Current State

The project already has `app_settings`, encrypted secret storage, and a settings API. The current implementation is still partial:

- `src/services/settings.ts` loads only a small `SETTINGS_KEYS` subset from DB.
- `src/config/env.ts` defines and validates many runtime values from `process.env`.
- `src/app.ts` loads DB settings only when `HTTP_ENABLED`, `SAVE_TO_DB`, or `AUTO_ACCEPT_ENABLED` are already true in env.
- `teams` already owns SPX cookie, device ID, and one LINE group per team.
- `docker-compose.yml` already splits `notifier`, `worker-ifn`, and `worker-ptwl` into separate processes.

## Source Of Truth

### Bootstrap Env

These stay in `.env` or Docker environment because the process needs them before DB config is available:

- `NODE_ENV`
- `DB_MODE`
- `DB_HOST`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_NAME`
- `SECRETS_KEY`

### Process Identity Env

These stay in Docker/service environment because they describe the machine/process, not business configuration:

- `SPX_ROLE`
- `SPX_NODE_ID`
- `SPX_NODE_NAME`
- `RUN_TEAM_IDS`
- `NOTIFIER_API_URL`
- `NOTIFIER_LOCAL_SPOOL_PATH`
- `HTTP_PORT`

`NOTIFIER_API_URL` remains process-scoped because each worker reaches the notifier through Docker networking, and another machine may use a different URL.

### Global DB Settings

These move to `app_settings` and become DB source of truth:

- SPX upstream/API: `API_URL`, `APP_NAME`, `REFERER`
- Polling/request behavior: `POLL_INTERVAL_MS`, `BOOKING_DETAIL_CONCURRENCY`, `BOOKING_REPROCESS_COOLDOWN_MS`, `BIDDING_PAGE_NO`, `BIDDING_PAGE_COUNT`, `REQUEST_TAB_PENDING_CONFIRMATION`, `REQUEST_CTIME_START`, `BIDDING_VEHICLE_TYPE`, `FETCH_DETAILS`, `SAVE_TO_DB`
- Runtime feature flags: `AUTO_ACCEPT_ENABLED`, `HTTP_ENABLED`, `DEBUG`
- Notification behavior: `NOTIFY_ENABLED`, `NOTIFY_MODE`, `NOTIFY_ORIGINS`, `NOTIFY_DESTINATIONS`, `NOTIFY_VEHICLE_TYPES`, `NOTIFY_MIN_TRIPS`
- Notifier auth/retry: `NOTIFIER_SHARED_SECRET`, `NOTIFIER_AUTH_MODE`, `NOTIFIER_REQUEST_TIMEOUT_MS`, `NOTIFIER_RETRY_MAX_ATTEMPTS`, `NOTIFIER_RETRY_BASE_DELAY_MS`
- HTTP/auth: `HTTP_ALLOWED_ORIGINS`, `HTTP_TRUST_PROXY`, `JWT_SECRET`, `COOKIE_SECRET`
- Admin bootstrap rows: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_ROLE`
- LINE/global providers: `LINE_CHANNEL_ACCESS_TOKEN`, `LINEJS_TEST_ENABLED`, `LINEJS_TEST_TARGET_ID`, `LINEJS_TEST_DEVICE`, `LINEJS_TEST_STORAGE_PATH`, `DISCORD_WEBHOOK_URL`, `LINE_IMAGE_LISTENER_CHAT_ID`
- AI/image: `CODEX_IMAGE_MODEL`, `CODEX_IMAGE_PROVIDER`, `CODEX_IMAGE_TIMEOUT_MS`, `CODEX_IMAGE_MAX_BYTES`

Secret DB values are encrypted with `SECRETS_KEY`. If `SECRETS_KEY` changes, stored encrypted values must be rotated through an explicit maintenance path.

### Team DB Settings

These remain team-scoped and encrypted in `teams`:

- SPX cookie
- SPX device ID
- Default LINE group
- Auto-accept success LINE group
- Auto-accept failure LINE group
- Enabled/disabled state

Global legacy keys `COOKIE`, `DEVICE_ID`, `LINE_USER_ID`, `LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS`, and `LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE` are treated only as migration inputs and are not shown as global settings.

## Startup Flow

1. Parse bootstrap env and process identity env.
2. Connect to DB or memory DB.
3. Ensure dashboard tables and migrations are ready.
4. Seed missing DB settings from existing env values once, without overwriting existing DB rows.
5. Load DB settings into `process.env` and the mutable `env` object.
6. Validate runtime config after DB values are loaded.
7. Create first admin user if no users exist and DB admin bootstrap values are valid.
8. Start HTTP, notifier dispatch loop, and assigned worker runtimes.

In production, failure to load required DB config is fatal. In development and tests, memory/default values can still be used so local tests stay simple.

## Live Reload Rules

Settings are grouped by reload behavior:

- `live`: applies to the current process immediately, such as poll interval, detail concurrency, notification toggles, and provider tokens.
- `restart-worker`: requires affected team runtimes to restart, such as team credentials and notification targets.
- `restart-process`: requires container/process restart, such as `HTTP_ENABLED`, auth signing secrets, notifier auth mode, and `SECRETS_KEY` rotation.

The settings API should return this reload hint so the UI can display whether a save was applied immediately or needs restart.

## Migration

The migration path is additive:

1. Add new DB setting keys and team columns.
2. On first DB-first boot, copy missing `.env` values into DB.
3. Preserve existing encrypted `app_settings` values.
4. Copy legacy LINE target values into team columns when those columns are empty.
5. After production verification, reduce `.env` to bootstrap and process identity keys.

## Verification

Required gates:

- `npm test -- settings-validation`
- `npm test -- team-repository`
- `npm test -- schema-consistency`
- `npm run typecheck`
- `npm run build`
- Production dry-run check: confirm DB rows exist, containers are healthy, notifier `/ready` passes, and workers use assigned `RUN_TEAM_IDS`.

## Acceptance Criteria

- Production workers and notifier can boot with `.env` containing only bootstrap and process identity values.
- Changing poller, SPX API, notification, auto-accept, and provider settings through DB/dashboard affects runtime according to reload rules.
- Team SPX credentials and LINE targets are encrypted and scoped per team.
- Missing required DB settings fail with a clear error naming the missing keys.
- No secret value is printed in logs, tests, docs, or command output.
