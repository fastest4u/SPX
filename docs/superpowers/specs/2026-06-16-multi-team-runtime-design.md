# Multi-Team Runtime Design

## Summary

SPX will move from one global poller/configuration to a team-scoped runtime model. A single Node.js process will manage multiple independent `Poller` instances, one per enabled team. Each team has its own SPX cookie, SPX device ID, LINE notification group, rules, history, auto-accept history, runtime state, and poller status. Global settings remain shared across all teams.

The selected approach is **Option B — Team Runtime Context**.

## Goals

- Support multiple teams in one SPX deployment.
- Allow one team to contain many users.
- Keep each team isolated from other teams' rules, history, auto-accept results, metrics, and runtime state.
- Use shared global settings for poll interval, SPX API URL, concurrency, LINE token/session, and other system-wide values.
- Store SPX cookie, SPX device ID, and LINE group per team.
- Let admins manage all teams, users, system settings, and pollers.
- Let users keep the current dashboard workflow, scoped to their own team.
- Run multiple team pollers in the same Node.js process for the expected 1-5 teams.

## Non-Goals

- Running each team in a separate process or Docker container.
- Letting users manage users, move users between teams, edit system settings, edit SPX cookies, edit device IDs, or edit LINE groups.
- Sharing team rules across all teams.
- Exposing raw SPX cookies through any API response.

## Current State

The current codebase is single-tenant:

- `src/app.ts` creates one `Poller`.
- `src/controllers/poller.ts` owns global in-memory poll state.
- `src/services/api-client.ts` reads `env.COOKIE` and `env.DEVICE_ID` from global runtime config.
- `src/services/notifier.ts` sends LINE notifications to global LINE targets.
- `src/services/notify-rules.ts` reads and writes a single global rules set.
- `users` only have `admin` or `user` roles and no team association.
- Core tables such as `notify_rules`, `spx_booking_history`, and `auto_accept_history` do not have `team_id`.

## Architecture

### Runtime Shape

```text
HTTP Dashboard / Admin API
        |
        v
TeamRuntimeManager
        |
        +-- TeamRuntime(team A)
        |     +-- Poller A
        |     +-- ApiClient A: Cookie A, Device ID A
        |     +-- Notifier A: LINE group A
        |
        +-- TeamRuntime(team B)
              +-- Poller B
              +-- ApiClient B: Cookie B, Device ID B
              +-- Notifier B: LINE group B
```

### TeamRuntimeManager

`TeamRuntimeManager` is the owner of all team poller lifecycles.

Responsibilities:

- Load teams where `enabled = true` on app startup.
- Skip enabled teams that are missing SPX cookie or device ID and mark them `misconfigured`.
- Create one `TeamRuntime` per runnable team.
- Keep runtimes in `Map<teamId, TeamRuntime>`.
- Restart only the affected team when an admin changes that team's cookie, device ID, LINE group, or enabled state.
- Support admin actions for `restartTeam`, `pauseTeam`, `resumeTeam`, and `restartAll`.
- Surface per-team runtime status for admin dashboards.

### TeamRuntime

`TeamRuntime` owns the dependencies and state for one team.

It contains:

- `teamId`
- `teamName`
- team secret/config snapshot
- one `ApiClient`
- one `Poller`
- one team-scoped notifier context
- team-scoped metrics/runtime status

The following state must not be shared between teams:

- `NeedBudget`
- `seenListBookingIds`
- `pendingFastLaneBookingIds`
- `recentlyProcessed`
- `detailFailureCounts`
- non-pending attempted request keys
- active detail booking IDs
- runtime pause/session-expired/error status

### Poller

`Poller` should receive an explicit team context instead of relying on global tenant state.

Conceptual constructor:

```text
new Poller({
  teamId,
  teamName,
  apiClient,
  notifier,
  rulesService,
  historyRepository,
  globalSettings
})
```

Each poller instance:

- polls SPX using its team's cookie and device ID;
- reads only its team's rules;
- writes only its team's booking history and auto-accept history;
- sends LINE messages only to its team's LINE group;
- emits metrics and SSE events with `teamId`;
- fails independently from other teams where possible.

### ApiClient

`ApiClient` should stop reading team-specific values from `env`.

Team-specific values:

- `spxCookie`
- `spxDeviceId`

Global values still come from shared runtime settings:

- `API_URL`
- `REFERER`
- `APP_NAME`
- `BIDDING_PAGE_COUNT`
- `REQUEST_TAB_PENDING_CONFIRMATION`
- `REQUEST_CTIME_START`
- `BIDDING_VEHICLE_TYPE`

Header construction must use the team context for `cookie` and `device-id`.

### Notifications

LINE account/token/session remains global. LINE destination is team-specific.

Notification flow:

```text
sendTeamLineMessage(teamId, message)
  team = getTeam(teamId)
  target = team.line_group_id
  send via shared LINE token/session to target
```

Rules:

- Auto-accept success/failure notifications go to the team's LINE group.
- Session-expired notifications go to the team's LINE group.
- Missing LINE group does not fail auto-accept.
- LINE send failures do not change the SPX accept result.
- Notification failures should be logged with `teamId`.

## Data Model

### New `teams` Table

```text
teams
- id
- name
- enabled
- spx_cookie
- spx_device_id
- line_group_id
- created_at
- updated_at
```

Storage rules:

- `spx_cookie` must be encrypted at rest.
- `line_group_id` should be treated as sensitive and redacted in API responses.
- `spx_device_id` must be encrypted at rest and redacted in API responses for consistency with other team credentials.

### Existing Tables Requiring `team_id`

```text
users
- team_id nullable

notify_rules
- team_id required

spx_booking_history
- team_id required

auto_accept_history
- team_id required

metrics_snapshots
- team_id required
```

### History Uniqueness

The existing unique index on `spx_booking_history.request_id` must become team-scoped:

```text
unique(team_id, request_id)
```

Reason: different SPX accounts may see the same upstream request ID. Team A and Team B must both be able to store their own row.

### Audit Logs

`audit_logs` should be extended to support team-aware auditing:

```text
audit_logs
- actor_user_id
- actor_team_id
- target_team_id
```

Audit examples:

- Admin changes team A cookie.
- Admin restarts all team pollers.
- User in team B creates a route rule.
- Admin moves a user from team A to team B.

### App Settings

`app_settings` remains global for system-wide configuration.

Global settings include:

```text
API_URL
POLL_INTERVAL_MS
BOOKING_DETAIL_CONCURRENCY
BOOKING_REPROCESS_COOLDOWN_MS
BIDDING_VEHICLE_TYPE
LINE_CHANNEL_ACCESS_TOKEN
LINEJS_TEST_ENABLED
LINEJS_TEST_DEVICE
LINEJS_TEST_STORAGE_PATH
DISCORD_WEBHOOK_URL
CODEX_IMAGE_PROVIDER
```

Move these values out of `app_settings` into `teams`:

```text
COOKIE
DEVICE_ID
LINE_USER_ID / LINE target group
```

## Migration Plan

### Default Team

Migration creates a default team from current single-team data:

```text
id = 1
name = "Default Team"
enabled = true
spx_cookie = current COOKIE from app_settings or env
spx_device_id = current DEVICE_ID from app_settings or env
line_group_id = current LINE target from app_settings or env
```

### Existing Data Mapping

- Existing `user` role accounts get `team_id = 1`.
- Existing `admin` accounts may use `team_id = null`.
- Existing rules get `team_id = 1`.
- Existing booking history rows get `team_id = 1`.
- Existing auto-accept history rows get `team_id = 1`.
- Existing metrics snapshots get `team_id = 1` if persisted per team in the same migration.

### Safe Migration Order

1. Create `teams` table.
2. Insert `Default Team`.
3. Add nullable `team_id` columns to existing tables.
4. Backfill `team_id = 1` for existing team-scoped records.
5. Backfill users by role.
6. Change team-scoped columns to required where appropriate.
7. Replace unique `request_id` index with unique `(team_id, request_id)`.
8. Remove or stop using global team-specific settings.

## Authorization Model

### AuthUser

Extend authenticated user shape:

```text
AuthUser
- id
- username
- role: admin | user
- teamId: number | null
```

### JWT

JWT payload includes `teamId`:

```text
- id
- username
- role
- teamId
- authVersion
- jti
```

Requests should still resolve current user state from DB so role/team changes revoke stale permissions through `authVersion`.

### Admin Permissions

Admins can:

- create, edit, disable, and delete teams;
- set any team's SPX cookie;
- set any team's device ID;
- set any team's LINE group;
- enable or disable any team;
- restart, pause, resume any team poller;
- restart all team pollers;
- create, edit, delete users;
- move users between teams;
- change user role and password;
- edit global system settings;
- view all teams and team statuses.

### User Permissions

Users can:

- use the dashboard for their own team;
- create, edit, and delete rules/routes for their own team;
- view their own team's history, auto-accept history, metrics, and notifications.

Users cannot:

- create, edit, delete, or move users;
- access team management endpoints;
- change global system settings;
- change SPX cookie;
- change device ID;
- change LINE group;
- see other teams' data.

### Endpoint Scope

Admin-only endpoints:

```text
/api/teams
/api/settings
/api/users
/api/audit-logs
```

Team-scoped user endpoints keep current paths where possible:

```text
/api/rules
/api/history
/api/auto-accept-history
/api/notifications
/api/bidding
```

For `user`, backend infers `teamId` from `req.user.teamId`.

For `admin`, endpoints that act on a team should require explicit `teamId` or use admin-only team endpoints.

### Scope Helpers

Add shared helpers:

```text
requireAdmin(req)
requireTeamUser(req)
getRequestTeamScope(req)
assertTeamScopedQuery(teamId)
```

Invariant: team-scoped repository functions must receive `teamId` explicitly.

## Backend API

### Teams API

```text
GET    /api/teams
POST   /api/teams
GET    /api/teams/:id
PUT    /api/teams/:id
POST   /api/teams/:id/disable
POST   /api/teams/:id/restart-poller
POST   /api/teams/:id/pause
POST   /api/teams/:id/resume
POST   /api/teams/restart-all
```

Responses must redact secrets:

```text
spx_cookie = ********1234
spx_device_id = ********1234
line_group_id = ********abcd
```

If a redacted secret is posted back unchanged, backend must preserve the existing stored value.

### Users API

Users management adds:

```text
teamId
teamName
```

Rules:

- `role = user` requires a team.
- `role = admin` may have `team_id = null`.
- Moving a user to another team increments `authVersion`.
- Changing role/password increments `authVersion`.

## Repository Scope

Team-scoped repository APIs should become explicit:

```text
readRules(teamId)
createRule(teamId, input)
updateRule(teamId, id, patch)
deleteRule(teamId, id)
getActiveAutoAcceptRules(teamId)
applyAutoAcceptProgress(teamId, updates)

insertBookingHistories(teamId, records)
getBookingHistory(teamId, query)
getBookingHistoryPaginated(teamId, query)

insertAutoAcceptHistory(teamId, record)
getAutoAcceptHistory(teamId, query)
getAutoAcceptHistoryPaginated(teamId, query)
```

Admin cross-team reporting must use separate functions with clear names such as `getAllTeamsAutoAcceptHistory`.

## Frontend Design

### User Dashboard

Users should keep the current dashboard experience. They should not need a team dropdown because their account is already scoped to one team.

User-visible pages remain familiar:

- Dashboard
- Rules
- History
- Auto-Accept History
- Notifications

Backend filters all data to the user's team.

Show read-only team status where useful:

```text
Team: Team A
Poller: Running / Paused / Session Expired / Misconfigured
LINE: Configured / Missing
```

### Admin UI

Admin navigation includes:

```text
Teams
Users
Settings
Audit Logs
```

### Teams Page

Team list columns:

```text
Team name
Enabled
Poller status
Last poll
Cookie status
Device ID status
LINE group status
Users count
Actions
```

Actions:

```text
Edit
Restart
Pause/Resume
Disable
```

### Team Form

Fields:

```text
name
enabled
spx_cookie
spx_device_id
line_group_id
```

Secrets should be redacted after save.

### Settings Page

Settings becomes global-only. Remove team-specific fields from settings and move them to Teams.

Global-only settings include:

```text
API_URL
POLL_INTERVAL_MS
BOOKING_DETAIL_CONCURRENCY
BOOKING_REPROCESS_COOLDOWN_MS
BIDDING_VEHICLE_TYPE
LINE token/session global config
other non-team-specific values
```

## SSE and Metrics

Every SSE event related to runtime state must include `teamId`.

Example:

```text
event: metrics
data: { teamId, ...metrics }
```

Behavior:

- User clients receive or display only their own team's events.
- Admin clients can see all teams or filter by selected team.
- Metrics should be scoped per team to avoid one team's poll latency hiding another team's failures.

## Error Handling

### Team Misconfigured

If a team is enabled but missing SPX cookie or device ID:

```text
runtime status = misconfigured
poller does not start
admin dashboard shows missing fields
app continues running
```

### Session Expired

If one team's SPX cookie expires:

```text
runtime status = session_expired
notify that team's LINE group
pause that team's poller until an admin updates the cookie or restarts the team
other teams continue running
```

### Missing LINE Group

If a team lacks a LINE group:

```text
auto-accept still runs
history is written
warning is logged with teamId
notification is skipped
```

### LINE Send Failure

If LINE send fails:

```text
SPX accept result remains authoritative
history remains written
notification error is logged
poller continues
```

## Safety Invariants

- Every team-scoped query must include `teamId`.
- Every team-scoped write must include `teamId`.
- Every poller log and metric should include `teamId`.
- Raw SPX cookies must never be returned by API responses.
- User role accounts must have a team.
- Admin role accounts may have no team.
- Admin restart-all actions must be audited.
- User rule changes must be audited with `teamId`.
- Default-team migration must complete before enforcing non-null team IDs.

## Testing Plan

### Build Checks

```text
npm run typecheck
npm run build
```

### Repository Checks

- User team A sees only rules from team A.
- User team B sees only rules from team B.
- User team A sees only history from team A.
- User team B sees only history from team B.
- Admin can list all teams.
- `unique(team_id, request_id)` allows two teams to store the same request ID.
- Team-scoped repository functions reject or cannot compile without `teamId`.

### Runtime Checks

- App starts pollers only for enabled and configured teams.
- Missing-cookie team becomes `misconfigured` without crashing app.
- Admin updates cookie/device ID and only that team's poller restarts.
- Admin restart-all restarts every running team runtime.
- Cookie expiry in team A does not stop team B.

### Notification Checks

- Team A auto-accept sends to LINE group A.
- Team B auto-accept sends to LINE group B.
- Missing LINE group skips notification without failing auto-accept.
- LINE send failure logs an error without changing SPX accept outcome.

### Security Checks

- User cannot access `/api/teams`.
- User cannot access `/api/settings`.
- User cannot access `/api/users`.
- User cannot move users between teams.
- User cannot update team cookie, device ID, or LINE group.
- API responses redact team secrets.

## Implementation Phases

1. Schema, migrations, teams repository, and auth team scope.
2. Admin Teams API, Users API changes, and global settings cleanup.
3. TeamRuntimeManager and multi-poller lifecycle.
4. Team-scoped rules, history, auto-accept, notifier, metrics, and SSE.
5. Frontend Teams UI, user scoping polish, migration verification, and full build checks.

## Final Decisions

- Teams are disabled, not hard-deleted, in the first implementation.
- Session-expired teams are paused until an admin updates the cookie or restarts that team.
- `spx_device_id` is encrypted at rest and redacted in API responses.
