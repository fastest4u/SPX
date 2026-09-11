# Frontend regression fixture

URL: [Dashboard](http://127.0.0.1:4180/). [Visible controls](http://127.0.0.1:4180/__fixture/controls). Port 4178 is a separate earlier fixture and is not modified or stopped by this harness.

The harness renders the current frontend from the workspace through programmatic Vite, React and Tailwind. Configuration and environment file loading are disabled; dependency cache and process cwd are under an isolated temporary directory. No route-tree generation plugin is loaded. Only rules use the real Fastify controller with the memory repository. Other endpoints are explicit stateful synthetic handlers shaped from the current frontend DTOs and backend routes.

## Routes and data

| Frontend route | Fixture coverage |
| --- | --- |
| `/login`, `/` | Synthetic login/logout/refresh/me; real rules CRUD/preview/review; metrics, history, quota, team enabled state, provider status |
| `/history` | 83 synthetic requests across two teams; search, request/booking/team/route/vehicle filters; sorting and pagination |
| `/notifications` | Message preview; test sends increment a local counter; optional LINE QR challenge |
| `/line-bot` | Status/login/logout, groups, profile, storage metadata and counted local sends |
| `/line-image-extractions` | 61 synthetic OCR records; local document SVG, date/month/agency/trip/driver/route/vehicle filtering and pagination |
| `/reports` | Metrics/history/audit CSV downloads with CSV headers and attachment filenames |
| `/auto-accept-history` | Success/failed/indeterminate fixture rows, filtering and pagination; manual accept actions are counted locally |
| `/audit` | Synthetic action history plus audit records emitted by real rule mutations; filtering, sorting, pagination |
| `/teams` | Stateful create/edit/disable/pause/resume/restart; team names/enabled state also sync to the memory repository |
| `/users` | Stateful create/password/role/team/delete, validation and self-change restrictions |
| `/settings/api`, `/settings/notifications`, `/settings/line-bot` | In-memory settings and reload metadata, masked secret fields, simulated Codex authorization, LINE state and group lookup |

Default is **admin + populated**. Use only these synthetic credentials:

- `fixture-admin` / `FixtureAdmin123!`
- `fixture-user` / `FixtureUser123!`
- `east-operator` / `FixtureEast123!`

Credentials are held only in fixture memory (password hashes for synthetic login). Requests record field names and byte counts; password, cookie, token, message and credential values are not recorded.

Admin endpoints enforce the current backend's admin boundary: teams, users, settings, audit, runtime and audit CSV. The own-team API requires a team user. The OCR endpoint follows its **current backend** user-scope access; the desired admin-only boundary being implemented in the frontend is a separate known backend gap, not simulated as already fixed here.

## Scenarios and evidence

Controls accept a `returnTo` frontend path, for example `/__fixture/controls?returnTo=/history`.

`/__fixture/scenario` supports:

- `mode=admin|user|anonymous` or separate `role=...`.
- `mode=populated|empty|error|recover`.
- `errorPrefix=/api/history` (or another API/metrics prefix) narrows error mode. `/api/me`, login/logout/refresh, health and ready stay available so data errors do not become fixture auth failures.
- `mode=preview-error|preview-delay|preview-expired|save-error|save-delay`, with `delayMs=1800` (0–10000).
- `mode=providerchallenge` (also `provider-challenge`) exposes `attention` / `challenge_required` provider state and local LINE QR metadata.
- `json=1` changes fixture state without redirecting, reloading or clearing browser query cache. Example: fetch `/__fixture/scenario?mode=recover&json=1`, then click the product page's retry action.
- `returnTo=/history` returns to that page when `json=1` is absent.
- `reset=1` reseeds rules when choosing populated/empty/recover. Empty mode empties collection responses and real rules; seeded history remains available to the real preview repository if a new rule is previewed.

`preview-expired` changes only public UI expiry metadata on a real preview response; genuine backend expiry is covered by the separate rule route tests.

- [Stats](http://127.0.0.1:4180/__fixture/stats): scenario, counters, sanitized API requests, unknown endpoint requests and blocked network reports.
- [Export](http://127.0.0.1:4180/__fixture/export): writes `output/verification/2026-09-11-frontend-regression/request-evidence.json`.
- `/__fixture/stop`: exports evidence and shuts down this fixture.

Unknown API path/method combinations return `501 FIXTURE_UNIMPLEMENTED`, so missing fixture coverage is visible. External Node fetch/HTTP(S) requests are blocked and recorded. Browser CSP restricts network resources to this local origin and records violations; external font links are removed, so system font fallback can occur. No provider, LINE, live DB, production app/http-server/poller or external sending client is started.

## Start and verification

```powershell
$fixtureCwd = Join-Path $env:TEMP 'spx-frontend-regression-fixture'
New-Item -ItemType Directory -Path $fixtureCwd -Force | Out-Null
Set-Location -LiteralPath $fixtureCwd
node C:/Users/Server/Desktop/SPX/node_modules/tsx/dist/cli.mjs C:/Users/Server/Desktop/SPX/output/verification/2026-09-11-frontend-regression/serve-fixture.ts
```

Startup smoke checked 16 primary read endpoints, CSV and controls: all returned 200. Browser verification and production frontend fixes are owned by the root task. This fixture does not establish production backend authorization, provider behavior or delivery reliability.

Source files: `output/verification/2026-09-11-frontend-regression/serve-fixture.ts` and `synthetic-api.ts`.

## Corrections during browser verification

The first fixture revision used LINE group IDs without the real group prefix and masked previews that did not meet the frontend's saved-secret preview format. This prevented group selection/team save for fixture reasons. The harness was corrected to use `cfixture-*` group IDs and `********fixture` previews; these are synthetic values. The fixture was restarted and the team edit, settings LINE target save, and notification preview/test send were repeated successfully. This was not a production frontend defect.

`request-evidence-before-group-fix.json` preserves the earlier successful local LINE send, pause/resume, and three CSV requests. `request-evidence-before-line-group-correction.json` is an overlapping snapshot of that same run; do not sum both snapshots. `request-evidence.json` holds the final post-restart run. Both distinct runs have zero unknown requests and zero recorded external network requests.
