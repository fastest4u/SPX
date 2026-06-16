# Multi-Team Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement team-scoped SPX polling so one deployment can run independent pollers for multiple teams while preserving admin control and user data isolation.

**Architecture:** Add a `teams` data model and explicit `teamId` scope through auth, repositories, controllers, notification routing, metrics, SSE, and poller runtime. A `TeamRuntimeManager` owns one `TeamRuntime` per enabled/configured team inside the same Node.js process, and each runtime owns its own `Poller`, `ApiClient`, notifier target, and in-memory state.

**Tech Stack:** TypeScript, Node.js 22, Fastify, Drizzle ORM, MySQL, better-sqlite3 memory tests, React 19, TanStack Router, TanStack Query, Vite.

---

## Execution Safety

- [ ] Run `git status --short` before starting implementation and record unrelated dirty files. Previously observed dirty `package.json` and `package-lock.json` must not be included unless the operator explicitly approves.
- [ ] Do not edit generated `src/frontend/routeTree.gen.ts` manually.
- [ ] Do not read, print, copy, or commit `.env` secrets.
- [ ] Do not commit, push, merge, deploy, or run production commands unless the operator explicitly asks.
- [ ] Use `npm test -- <name>` for focused standalone tests, then `npm run typecheck`, then `npm run build` before claiming implementation complete.

## File Structure

### Create

- `migrations/018_multi_team_runtime.sql` — MySQL migration for teams and team-scoped columns/indexes.
- `src/repositories/team-repository.ts` — encrypted team config persistence, redaction, default team bootstrap, team status metadata.
- `src/services/team-scope.ts` — shared authorization helpers for resolving required team scope from `req.user`.
- `src/services/team-runtime.ts` — one team runtime wrapper around `Poller`, `ApiClient`, notifier context, and per-team status.
- `src/services/team-runtime-manager.ts` — lifecycle manager for all team runtimes.
- `src/controllers/teams-controller.ts` — admin-only Teams API.
- `src/frontend/routes/teams.tsx` — admin Teams page.
- `tests/multi-team-schema.test.ts` — schema/migration parity and team_id invariants.
- `tests/team-repository.test.ts` — team encryption/redaction/default-team repository behavior.
- `tests/auth-team-scope.test.ts` — auth payload, user team assignment, authVersion invalidation.
- `tests/team-scoped-repositories.test.ts` — rules/history/auto-accept isolation.
- `tests/api-client-team-headers.test.ts` — team cookie/device-id headers.
- `tests/team-runtime-manager.test.ts` — runtime lifecycle behavior with fake team configs.

### Modify

- `src/db/schema.ts` — add `teams`, `teamId`, audit team fields, and team-scoped indexes.
- `src/db/client.ts` — runtime MySQL DDL parity for `teams` and changed tables.
- `src/db/client-memory.ts` — SQLite memory schema parity.
- `src/repositories/app-settings-repository.ts` — remove team secrets from global secret-setting workflow after migration compatibility is handled.
- `src/services/settings.ts` — keep global settings only; stop exposing team-specific keys through Settings API.
- `src/repositories/user-repository.ts` — add `teamId`, `teamName`, create/update team assignment, auth state with team scope.
- `src/services/authz.ts` — extend `AuthUser` with `teamId` and keep role model `admin | user`.
- `src/services/auth-session.ts` — resolve `teamId` from DB and revoke stale tokens via `authVersion`.
- `src/controllers/auth-controller.ts` — sign `teamId` into JWT on login/refresh.
- `src/controllers/users-controller.ts` — require admin, add team assignment inputs, prevent user-role records without team.
- `src/services/http-server.ts` — register `teamsController`, register team-scoped controllers in the right scopes.
- `src/controllers/rules-controller.ts` — pass `teamId` into rules/history preview functions.
- `src/services/notify-rules.ts` — team-scoped rules and cache keyed by `teamId`.
- `src/repositories/booking-history-repository.ts` — team-scoped inserts/lists/pagination.
- `src/repositories/auto-accept-repository.ts` — team-scoped inserts/lists/pagination/recent keys.
- `src/repositories/audit-repository.ts` — optional team-aware fields for actor/target context.
- `src/controllers/history-controller.ts` — filter by request team scope.
- `src/controllers/auto-accept-history-controller.ts` — filter by request team scope and support admin team query.
- `src/controllers/bidding-controller.ts` — use team runtime/client for manual accept.
- `src/services/api-client.ts` — accept team credentials and use them in request headers.
- `src/services/notifier.ts` — route auto-accept/session notifications to team LINE group.
- `src/controllers/poller.ts` — accept `TeamPollerContext` and isolate all runtime state per instance.
- `src/services/poller-control.ts` — replace global pause flag with per-team controls.
- `src/services/metrics.ts` and `src/repositories/metrics-repository.ts` — add `teamId` to runtime and persisted metrics.
- `src/services/sse.ts` — attach `teamId` to events and filter user clients.
- `src/controllers/dashboard-controller.ts` — expose team-scoped metrics/control for users and admin aggregate/control endpoints.
- `src/app.ts` — start `TeamRuntimeManager` instead of a single global poller.
- `src/frontend/types/index.ts` — add `Team`, `TeamInput`, team-scoped auth/user/metrics types.
- `src/frontend/lib/api.ts` — add `teamsApi`, team-aware users payloads, and global-only settings types.
- `src/frontend/components/layout/AppLayout.tsx` — add Teams nav for admins and show team label for users.
- `src/frontend/routes/users.tsx` — admin team selector for create/edit users.
- `src/frontend/routes/settings.api.tsx`, `src/frontend/routes/settings.notifications.tsx`, `src/frontend/routes/settings.line-bot.tsx`, `src/frontend/lib/settings-shared.tsx` — remove team-specific settings from global Settings UI.

---

### Task 1: Schema, Migration, and Runtime DDL Parity

**Files:**

- Create: `migrations/018_multi_team_runtime.sql`
- Create: `tests/multi-team-schema.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/client-memory.ts`
- Modify: `src/repositories/metrics-repository.ts`

- [ ] **Step 1: Write failing schema invariant test**

Create `tests/multi-team-schema.test.ts` with assertions for the new team table, `team_id` columns, and team-scoped history uniqueness. Use source-text checks because the repo already has `schema-consistency.test.ts` for DDL parity.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

const schema = read("src/db/schema.ts");
const mysqlDdl = `${read("src/db/client.ts")}\n${read("src/repositories/metrics-repository.ts")}`;
const sqliteDdl = read("src/db/client-memory.ts");
const migration = read("migrations/018_multi_team_runtime.sql");

for (const source of [schema, mysqlDdl, sqliteDdl, migration]) {
  assert.match(source, /teams/i, "teams table must exist in schema, DDL, and migration");
  assert.match(source, /team[_A-Za-z]*id|team_id/i, "team id must exist in schema, DDL, and migration");
}

assert.match(schema, /unique\([^)]*teamId[^)]*requestId|unique\([^)]*team_id[^)]*request_id/i, "Drizzle schema must express team-scoped request uniqueness");
assert.match(migration, /team_id[^\n]+request_id|request_id[^\n]+team_id/i, "migration must replace request-only uniqueness with team/request uniqueness");
assert.doesNotMatch(schema, /COOKIE\?:|DEVICE_ID\?:|LINE_USER_ID\?:/, "frontend/global settings should stop treating team credentials as global settings after this plan is complete");

console.log("multi-team-schema: team schema invariants verified");
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- multi-team-schema`

Expected: FAIL because `migrations/018_multi_team_runtime.sql` and `teams` schema do not exist yet.

- [ ] **Step 3: Add Drizzle schema changes**

Update `src/db/schema.ts` with:

```ts
export const teams = mysqlTable("teams", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  enabled: int("enabled").notNull().default(1),
  spxCookie: varchar("spx_cookie", { length: 4000 }).notNull().default(""),
  spxDeviceId: varchar("spx_device_id", { length: 1000 }).notNull().default(""),
  lineGroupId: varchar("line_group_id", { length: 255 }).notNull().default(""),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  enabledIdx: index("teams_enabled_idx").on(table.enabled),
  nameIdx: index("teams_name_idx").on(table.name),
}));
```

Add `teamId` to `users`, `notifyRules`, `spxBookingHistory`, `autoAcceptHistory`, and `metricsSnapshots`. Add audit fields to `auditLogs`:

```ts
teamId: int("team_id"),
actorUserId: int("actor_user_id"),
actorTeamId: int("actor_team_id"),
targetTeamId: int("target_team_id"),
```

Use non-null `teamId` for team-owned records and nullable `teamId` for admin users.

- [ ] **Step 4: Add MySQL migration**

Create `migrations/018_multi_team_runtime.sql` with a one-time migration that:

```sql
CREATE TABLE IF NOT EXISTS teams (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  spx_cookie VARCHAR(4000) NOT NULL DEFAULT '',
  spx_device_id VARCHAR(1000) NOT NULL DEFAULT '',
  line_group_id VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY teams_enabled_idx (enabled),
  KEY teams_name_idx (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO teams (id, name, enabled, spx_cookie, spx_device_id, line_group_id)
VALUES (1, 'Default Team', 1, '', '', '')
ON DUPLICATE KEY UPDATE name = name;

ALTER TABLE users ADD COLUMN team_id INT NULL AFTER role;
UPDATE users SET team_id = 1 WHERE role <> 'admin' AND team_id IS NULL;
ALTER TABLE users ADD INDEX users_team_id_idx (team_id);

ALTER TABLE notify_rules ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE notify_rules ADD INDEX notify_rules_team_id_idx (team_id);

ALTER TABLE spx_booking_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE spx_booking_history DROP INDEX request_id_idx;
ALTER TABLE spx_booking_history ADD UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id);
ALTER TABLE spx_booking_history ADD INDEX spx_booking_history_team_created_idx (team_id, created_at);

ALTER TABLE auto_accept_history ADD COLUMN team_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE auto_accept_history ADD INDEX aah_team_created_at_idx (team_id, created_at);
ALTER TABLE auto_accept_history ADD INDEX aah_team_status_created_at_idx (team_id, status, created_at);

ALTER TABLE audit_logs ADD COLUMN actor_user_id INT NULL AFTER id;
ALTER TABLE audit_logs ADD COLUMN actor_team_id INT NULL AFTER actor_user_id;
ALTER TABLE audit_logs ADD COLUMN target_team_id INT NULL AFTER actor_team_id;
ALTER TABLE audit_logs ADD INDEX audit_target_team_created_at_idx (target_team_id, created_at);
```

Add the `metrics_snapshots.team_id` DDL in the same migration if `metrics_snapshots` is created by migrations in this repo; otherwise add it to runtime DDL and document that persisted metrics get team scope on next `db:generate` cycle.

- [ ] **Step 5: Update runtime MySQL DDL**

Update `src/db/client.ts` and `src/repositories/metrics-repository.ts` so `CREATE TABLE IF NOT EXISTS` definitions match `src/db/schema.ts`. Replace `UNIQUE KEY request_id_idx (request_id)` with `UNIQUE KEY spx_booking_history_team_request_uidx (team_id, request_id)`.

- [ ] **Step 6: Update memory SQLite DDL**

Update `src/db/client-memory.ts` to mirror the new tables and columns. For SQLite history uniqueness, use:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS spx_booking_history_team_request_uidx
ON spx_booking_history(team_id, request_id);
```

- [ ] **Step 7: Run schema tests**

Run: `npm test -- schema`

Expected: PASS for `schema-consistency.test.ts` and `multi-team-schema.test.ts`.

- [ ] **Step 8: Run typecheck checkpoint**

Run: `npm run typecheck`

Expected: initial failures are acceptable only where later tasks intentionally update repository/controller signatures. Record failures before continuing.

---

### Task 2: Team Repository, Encryption, Redaction, and Default Team Bootstrap

**Files:**

- Create: `src/repositories/team-repository.ts`
- Create: `tests/team-repository.test.ts`
- Modify: `src/repositories/app-settings-repository.ts`
- Modify: `src/services/settings.ts`

- [ ] **Step 1: Write failing team repository test**

Create `tests/team-repository.test.ts`:

```ts
process.env.DB_MODE = "memory";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  resetMemoryDb();

  const created = await teams.createTeam({
    name: "Team A",
    enabled: true,
    spxCookie: "cookie-a-secret",
    spxDeviceId: "device-a-secret",
    lineGroupId: "line-group-a",
  });

  assert.equal(created.name, "Team A");
  assert.equal(created.enabled, true);
  assert.equal(created.hasSpxCookie, true);
  assert.equal(created.hasSpxDeviceId, true);
  assert.equal(created.hasLineGroupId, true);
  assert.notEqual(created.spxCookiePreview, "cookie-a-secret");
  assert.notEqual(created.spxDeviceIdPreview, "device-a-secret");
  assert.notEqual(created.lineGroupIdPreview, "line-group-a");

  const runtime = await teams.getTeamRuntimeConfig(created.id);
  assert.ok(runtime);
  assert.equal(runtime.spxCookie, "cookie-a-secret");
  assert.equal(runtime.spxDeviceId, "device-a-secret");
  assert.equal(runtime.lineGroupId, "line-group-a");

  const preserved = await teams.updateTeam(created.id, {
    name: "Team A renamed",
    spxCookie: created.spxCookiePreview,
    spxDeviceId: created.spxDeviceIdPreview,
    lineGroupId: created.lineGroupIdPreview,
  });
  assert.ok(preserved);
  const runtimeAfterRedactedSave = await teams.getTeamRuntimeConfig(created.id);
  assert.equal(runtimeAfterRedactedSave?.spxCookie, "cookie-a-secret");
  assert.equal(runtimeAfterRedactedSave?.spxDeviceId, "device-a-secret");
  assert.equal(runtimeAfterRedactedSave?.lineGroupId, "line-group-a");

  await teams.disableTeam(created.id);
  const disabled = await teams.getTeamById(created.id);
  assert.equal(disabled?.enabled, false);

  console.log("team-repository: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- team-repository`

Expected: FAIL because `src/repositories/team-repository.ts` does not exist.

- [ ] **Step 3: Implement repository types and redaction helpers**

Create exported types with stable names:

```ts
export interface TeamInput {
  name: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
}

export interface TeamPatch {
  name?: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
}

export interface RedactedTeam {
  id: number;
  name: string;
  enabled: boolean;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
  hasLineGroupId: boolean;
  spxCookiePreview: string;
  spxDeviceIdPreview: string;
  lineGroupIdPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRuntimeConfig {
  id: number;
  name: string;
  enabled: boolean;
  spxCookie: string;
  spxDeviceId: string;
  lineGroupId: string;
}
```

- [ ] **Step 4: Implement encryption and redaction behavior**

Use existing `encryptString` and `decryptString` from `src/utils/crypto.ts`. Treat posted redacted values as preserve-existing by checking the mask prefix:

```ts
const REDACTED_PREFIX = "********";

function isRedactedPlaceholder(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(REDACTED_PREFIX);
}
```

- [ ] **Step 5: Implement repository functions**

Implement and export:

```ts
listTeams(): Promise<RedactedTeam[]>
getTeamById(id: number): Promise<RedactedTeam | null>
getTeamRuntimeConfig(id: number): Promise<TeamRuntimeConfig | null>
listEnabledTeamRuntimeConfigs(): Promise<TeamRuntimeConfig[]>
createTeam(input: TeamInput): Promise<RedactedTeam>
updateTeam(id: number, patch: TeamPatch): Promise<RedactedTeam | null>
disableTeam(id: number): Promise<boolean>
ensureDefaultTeamFromLegacySettings(): Promise<RedactedTeam>
```

`ensureDefaultTeamFromLegacySettings()` must create team `1` if absent and copy legacy stored `COOKIE`, `DEVICE_ID`, and `LINE_USER_ID` values from `app_settings` when available. Do not read `.env` directly in tests; runtime env fallback is handled by normal settings bootstrap.

- [ ] **Step 6: Remove team secrets from global settings exposure**

Update `src/services/settings.ts` so future Settings API responses do not include `COOKIE`, `DEVICE_ID`, `LINE_USER_ID`, `LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS`, or `LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE`. Keep migration compatibility in repository code so legacy values can seed Default Team once.

- [ ] **Step 7: Run focused tests**

Run: `npm test -- team-repository`

Expected: PASS.

Run: `npm test -- settings-validation`

Expected: PASS.

---

### Task 3: Auth, User Team Assignment, and Team Scope Helpers

**Files:**

- Create: `src/services/team-scope.ts`
- Create: `tests/auth-team-scope.test.ts`
- Modify: `src/repositories/user-repository.ts`
- Modify: `src/services/authz.ts`
- Modify: `src/services/auth-session.ts`
- Modify: `src/controllers/auth-controller.ts`
- Modify: `src/controllers/users-controller.ts`

- [ ] **Step 1: Write failing auth team-scope test**

Create `tests/auth-team-scope.test.ts`:

```ts
process.env.DB_MODE = "memory";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const users = await import("../src/repositories/user-repository.js");
  const { resolveAuthUserFromJwtPayload } = await import("../src/services/auth-session.js");
  resetMemoryDb();

  const team = await teams.createTeam({ name: "Team Scope", enabled: true, spxCookie: "c", spxDeviceId: "d", lineGroupId: "g" });
  await users.createUser("team-user", "password-123456", "user", team.id);
  const user = await users.getUserByUsername("team-user");
  assert.ok(user);
  assert.equal(user.teamId, team.id);

  const resolved = await resolveAuthUserFromJwtPayload({
    id: user.id,
    username: user.username,
    role: user.role,
    teamId: user.teamId,
    authVersion: user.authVersion,
    jti: "team-scope-jti",
  });
  assert.deepEqual(resolved, { id: user.id, username: "team-user", role: "user", teamId: team.id });

  const adminId = await users.createUser("global-admin", "password-123456", "admin", null);
  const admin = await users.getUserAuthStateById(adminId);
  assert.ok(admin);
  assert.equal(admin.teamId, null);

  const moved = await users.updateUserTeam(user.id, null);
  assert.equal(moved, false, "user role cannot be moved to null team");

  const otherTeam = await teams.createTeam({ name: "Other Team", enabled: true, spxCookie: "c2", spxDeviceId: "d2", lineGroupId: "g2" });
  const movedToOtherTeam = await users.updateUserTeam(user.id, otherTeam.id);
  assert.equal(movedToOtherTeam, true);
  const afterMove = await users.getUserAuthStateById(user.id);
  assert.equal(afterMove?.teamId, otherTeam.id);
  assert.equal(afterMove?.authVersion, (user.authVersion ?? 0) + 1);

  console.log("auth-team-scope: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- auth-team-scope`

Expected: FAIL because user repository and auth types do not yet support `teamId`.

- [ ] **Step 3: Extend auth types**

Update `src/services/authz.ts`:

```ts
export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  teamId: number | null;
}
```

- [ ] **Step 4: Extend user repository signatures**

Update `createUser`, `getUserByUsername`, `getUserAuthStateById`, list users, and update functions to include `teamId` and `teamName`. Preserve admin creation by allowing `teamId = null` only for `role === "admin"`.

Required exported functions:

```ts
createUser(username: string, password: string, role?: UserRole, teamId?: number | null): Promise<number>
updateUserTeam(id: number, teamId: number | null): Promise<boolean>
updateUserRole(id: number, role: UserRole, teamId?: number | null): Promise<boolean>
```

- [ ] **Step 5: Extend auth session resolution**

Update `AuthTokenPayload` in `src/services/auth-session.ts` with `teamId?: number | null`. Resolve current `teamId` from `getUserAuthStateById` and return DB-backed team scope, not payload-only team scope.

- [ ] **Step 6: Sign teamId in JWT**

Update `src/controllers/auth-controller.ts` login and refresh signing payloads:

```ts
{ username: user.username, id: user.id, role: user.role, teamId: user.teamId, authVersion: user.authVersion ?? 0, jti }
```

- [ ] **Step 7: Add team scope helpers**

Create `src/services/team-scope.ts`:

```ts
import type { AuthUser } from "./authz.js";
import { AppError } from "../utils/errors.js";

export function requireRequestUser(req: { user?: unknown }): AuthUser {
  const user = req.user as AuthUser | undefined;
  if (!user) throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  return user;
}

export function requireTeamUser(req: { user?: unknown }): number {
  const user = requireRequestUser(req);
  if (user.role !== "user" || typeof user.teamId !== "number") {
    throw new AppError("TEAM_REQUIRED", "Team scope is required", 400);
  }
  return user.teamId;
}

export function resolveScopedTeamId(req: { user?: unknown }, explicitTeamId?: number): number {
  const user = requireRequestUser(req);
  if (user.role === "admin") {
    if (typeof explicitTeamId !== "number") throw new AppError("TEAM_REQUIRED", "Admin requests must include teamId", 400);
    return explicitTeamId;
  }
  if (typeof user.teamId !== "number") throw new AppError("TEAM_REQUIRED", "Team scope is required", 400);
  return user.teamId;
}
```

- [ ] **Step 8: Update users controller**

Update `src/controllers/users-controller.ts` body schemas to accept `teamId`. Enforce:

- creating `role = user` requires `teamId`;
- creating `role = admin` allows `teamId = null`;
- moving team increments `authVersion`;
- user endpoints remain admin-only through current HTTP server route scope.

- [ ] **Step 9: Run focused auth tests**

Run: `npm test -- auth-session-revocation`

Expected: PASS after expected result updates include `teamId`.

Run: `npm test -- auth-team-scope`

Expected: PASS.

---

### Task 4: Admin Teams API and Route Registration

**Files:**

- Create: `src/controllers/teams-controller.ts`
- Modify: `src/services/http-server.ts`
- Create: `tests/teams-controller-auth.test.ts`

- [ ] **Step 1: Write failing Teams API auth test**

Create `tests/teams-controller-auth.test.ts` with a Fastify instance if existing controller tests provide a helper. If no helper exists, test the controller-independent policy functions from `teams-controller.ts` by exporting `teamSchema`, `teamPatchSchema`, and `toTeamPatch`.

Minimum assertions:

```ts
import assert from "node:assert/strict";
import { toTeamPatch } from "../src/controllers/teams-controller.js";

assert.deepEqual(toTeamPatch({ name: " A ", enabled: true }), { name: "A", enabled: true });
assert.deepEqual(toTeamPatch({ spxCookie: "********abcd" }), { spxCookie: "********abcd" });
assert.throws(() => toTeamPatch({ name: "" }), /name/i);
console.log("teams-controller-auth: schema helpers verified");
```

- [ ] **Step 2: Run failing controller test**

Run: `npm test -- teams-controller-auth`

Expected: FAIL because `teams-controller.ts` does not exist.

- [ ] **Step 3: Implement Teams controller**

Create admin-only plugin endpoints:

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

Use `team-repository.ts` for persistence and call a runtime manager accessor for runtime actions. Return redacted team data only.

- [ ] **Step 4: Register Teams controller**

Update `src/services/http-server.ts` imports and admin scope:

```ts
import { teamsController } from "../controllers/teams-controller.js";
```

Register it in the admin scope:

```ts
await adminScope.register(teamsController, { prefix: "/teams" });
```

- [ ] **Step 5: Add audit logs for admin team changes**

Use `insertAuditLog` for create/update/disable/restart/pause/resume/restart-all. Include target team id in the details until `audit-repository.ts` is extended in Task 5.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- teams-controller-auth`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS for the Teams API portion before repository-scope refactors begin.

---

### Task 5: Team-Scoped Rules, History, Auto-Accept History, and Audit

**Files:**

- Create: `tests/team-scoped-repositories.test.ts`
- Modify: `src/services/notify-rules.ts`
- Modify: `src/controllers/rules-controller.ts`
- Modify: `src/repositories/booking-history-repository.ts`
- Modify: `src/controllers/history-controller.ts`
- Modify: `src/repositories/auto-accept-repository.ts`
- Modify: `src/controllers/auto-accept-history-controller.ts`
- Modify: `src/repositories/audit-repository.ts`
- Modify: `src/controllers/audit-controller.ts`

- [ ] **Step 1: Write failing repository isolation test**

Create `tests/team-scoped-repositories.test.ts`:

```ts
process.env.DB_MODE = "memory";

import assert from "node:assert/strict";

async function main(): Promise<void> {
  const { resetMemoryDb } = await import("../src/db/client-memory.js");
  const teams = await import("../src/repositories/team-repository.js");
  const rules = await import("../src/services/notify-rules.js");
  const history = await import("../src/repositories/booking-history-repository.js");
  const autoAccept = await import("../src/repositories/auto-accept-repository.js");
  resetMemoryDb();

  const teamA = await teams.createTeam({ name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" });
  const teamB = await teams.createTeam({ name: "B", enabled: true, spxCookie: "cb", spxDeviceId: "db", lineGroupId: "gb" });

  const ruleA = await rules.createRule(teamA.id, { name: "A route", origins: ["A"], destinations: ["X"], vehicle_types: [], need: 1, enabled: true, fulfilled: false, auto_accepted: false });
  const ruleB = await rules.createRule(teamB.id, { name: "B route", origins: ["B"], destinations: ["Y"], vehicle_types: [], need: 1, enabled: true, fulfilled: false, auto_accepted: false });

  assert.deepEqual((await rules.readRules(teamA.id)).map((r) => r.id), [ruleA.id]);
  assert.deepEqual((await rules.readRules(teamB.id)).map((r) => r.id), [ruleB.id]);

  const rec = {
    requestId: 9001,
    bookingId: 19001,
    bookingName: "same upstream request",
    agencyName: "agency",
    route: "A-X",
    origin: "A",
    destination: "X",
    costType: "cost",
    tripType: "trip",
    shiftType: "shift",
    vehicleType: "4W",
    standbyDateTime: "2026-06-16 10:00:00",
    acceptanceStatus: 1,
    assignmentStatus: 0,
  };

  assert.deepEqual(await history.insertBookingHistories(teamA.id, [rec]), { inserted: 1, skipped: 0 });
  assert.deepEqual(await history.insertBookingHistories(teamB.id, [rec]), { inserted: 1, skipped: 0 });
  assert.equal((await history.getBookingHistory(teamA.id, { limit: 20 })).length, 1);
  assert.equal((await history.getBookingHistory(teamB.id, { limit: 20 })).length, 1);

  await autoAccept.insertAutoAcceptHistory(teamA.id, { ruleId: ruleA.id, ruleName: ruleA.name, bookingId: 19001, requestIds: [9001], acceptedCount: 1, origin: "A", destination: "X", vehicleType: "4W", status: "success" });
  await autoAccept.insertAutoAcceptHistory(teamB.id, { ruleId: ruleB.id, ruleName: ruleB.name, bookingId: 19001, requestIds: [9001], acceptedCount: 1, origin: "B", destination: "Y", vehicleType: "4W", status: "success" });
  assert.equal((await autoAccept.getAutoAcceptHistory(teamA.id, { limit: 20 })).length, 1);
  assert.equal((await autoAccept.getAutoAcceptHistory(teamB.id, { limit: 20 })).length, 1);

  console.log("team-scoped-repositories: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Run failing repository test**

Run: `npm test -- team-scoped-repositories`

Expected: FAIL because repository signatures are still global.

- [ ] **Step 3: Refactor notify rules service**

Change signatures:

```ts
readRules(teamId: number): Promise<NotifyRule[]>
createRule(teamId: number, input: NotifyRuleInput): Promise<NotifyRule>
updateRule(teamId: number, id: string, patch: NotifyRulePatch): Promise<NotifyRule | null>
deleteRule(teamId: number, id: string): Promise<NotifyRule | null>
```

Cache rules by `teamId`:

```ts
const rulesCache = new Map<number, { loadedAt: number; rules: NotifyRule[] }>();
```

Invalidate only the affected team cache after create/update/delete.

- [ ] **Step 4: Refactor booking history repository**

Change insert/list/paginated functions to require `teamId`. Update duplicate handling to use `(team_id, request_id)`. Keep return shape `{ inserted, skipped }` unchanged.

- [ ] **Step 5: Refactor auto-accept repository**

Change insert/list/paginated/recent-key functions to require `teamId`. Ensure recent-key lookups only suppress duplicate accept attempts within the same team.

- [ ] **Step 6: Update controllers to resolve team scope**

Use `resolveScopedTeamId(req, query.teamId)` in controllers that can be used by admins with explicit `teamId`. Use `requireTeamUser(req)` for user-only paths that never support admin cross-team behavior.

- [ ] **Step 7: Extend audit repository**

Add optional fields to audit insert input:

```ts
insertAuditLog(username: string, action: string, details?: string, options?: { actorUserId?: number; actorTeamId?: number | null; targetTeamId?: number | null }): Promise<void>
```

Keep existing call sites working by making `options` optional.

- [ ] **Step 8: Run repository tests**

Run: `npm test -- team-scoped-repositories`

Expected: PASS.

Run: `npm test -- notify-rules-matching`

Expected: PASS after updating call sites to pass a team id in tests.

Run: `npm test -- booking-history-repository`

Expected: PASS after updating test to pass `teamId`.

---

### Task 6: Team Credentials in ApiClient and Notifications

**Files:**

- Create: `tests/api-client-team-headers.test.ts`
- Modify: `src/services/api-client.ts`
- Modify: `src/services/notifier.ts`
- Modify: `src/controllers/bidding-controller.ts`
- Modify: `src/services/line-bot.ts` only if send target helpers need a clearer boundary

- [ ] **Step 1: Write failing ApiClient team header test**

Create `tests/api-client-team-headers.test.ts` with an exported header builder if needed. Prefer exporting a narrow pure helper from `api-client.ts`:

```ts
import assert from "node:assert/strict";
import { buildHeadersForRequest } from "../src/services/api-client.js";

const headers = buildHeadersForRequest({ spxCookie: "team-cookie", spxDeviceId: "team-device" });
assert.equal(headers.cookie, "team-cookie");
assert.equal(headers["device-id"], "team-device");
console.log("api-client-team-headers: all assertions passed");
```

- [ ] **Step 2: Run failing ApiClient test**

Run: `npm test -- api-client-team-headers`

Expected: FAIL because `buildHeadersForRequest` does not exist and headers still read global team credentials.

- [ ] **Step 3: Add ApiClient team credential options**

Introduce:

```ts
export interface ApiClientCredentials {
  spxCookie: string;
  spxDeviceId: string;
}
```

Update `ApiClient` constructor to receive credentials. Keep global SPX API values from `env` and live settings. Remove `cookieOverride` once all call sites use credentials.

- [ ] **Step 4: Refactor request headers**

Make header construction pure and testable:

```ts
export function buildHeadersForRequest(credentials: ApiClientCredentials): Record<string, string> {
  return {
    ...baseHeaders,
    "device-id": credentials.spxDeviceId,
    cookie: credentials.spxCookie,
  };
}
```

- [ ] **Step 5: Add team notifier context**

In `src/services/notifier.ts`, add a small context type:

```ts
export interface TeamNotificationContext {
  teamId: number;
  teamName: string;
  lineGroupId: string;
}
```

Update auto-accept/session notification functions to accept `TeamNotificationContext` and send to `lineGroupId`. Missing `lineGroupId` logs warning and returns a skipped notification result.

- [ ] **Step 6: Update manual bidding accept**

Update `src/controllers/bidding-controller.ts` so manual accept uses the authenticated user's team runtime/client. Admin manual accept must require explicit `teamId`.

- [ ] **Step 7: Run focused tests**

Run: `npm test -- api-client-team-headers`

Expected: PASS.

Run: `npm test -- auto-accept`

Expected: PASS after test call sites pass team notification context.

---

### Task 7: TeamRuntime and TeamRuntimeManager

**Files:**

- Create: `src/services/team-runtime.ts`
- Create: `src/services/team-runtime-manager.ts`
- Create: `tests/team-runtime-manager.test.ts`
- Modify: `src/controllers/poller.ts`
- Modify: `src/services/poller-control.ts`
- Modify: `src/app.ts`
- Modify: `src/services/http-server.ts` if runtime manager dependency injection is needed for controllers

- [ ] **Step 1: Write failing runtime manager test**

Create `tests/team-runtime-manager.test.ts` using fake runtime factories:

```ts
import assert from "node:assert/strict";
import { TeamRuntimeManager } from "../src/services/team-runtime-manager.js";

const events: string[] = [];
const manager = new TeamRuntimeManager({
  loadEnabledTeams: async () => [
    { id: 1, name: "A", enabled: true, spxCookie: "ca", spxDeviceId: "da", lineGroupId: "ga" },
    { id: 2, name: "B", enabled: true, spxCookie: "", spxDeviceId: "db", lineGroupId: "gb" },
  ],
  createRuntime: (team) => ({
    teamId: team.id,
    start: async () => { events.push(`start:${team.id}`); },
    stop: async () => { events.push(`stop:${team.id}`); },
    pause: () => { events.push(`pause:${team.id}`); },
    resume: () => { events.push(`resume:${team.id}`); },
    status: () => ({ teamId: team.id, status: "running" as const }),
  }),
});

await manager.startAllEnabledTeams();
assert.deepEqual(events, ["start:1"]);
assert.equal(manager.getStatus(2)?.status, "misconfigured");

await manager.pauseTeam(1);
await manager.resumeTeam(1);
await manager.restartTeam(1);
assert.deepEqual(events, ["start:1", "pause:1", "resume:1", "stop:1", "start:1"]);
console.log("team-runtime-manager: all assertions passed");
```

- [ ] **Step 2: Run failing runtime test**

Run: `npm test -- team-runtime-manager`

Expected: FAIL because runtime manager does not exist.

- [ ] **Step 3: Implement TeamRuntime status model**

Create statuses:

```ts
export type TeamRuntimeStatusValue = "stopped" | "running" | "paused" | "misconfigured" | "session_expired" | "error";

export interface TeamRuntimeStatus {
  teamId: number;
  teamName: string;
  status: TeamRuntimeStatusValue;
  lastPollAt: string | null;
  lastError: string | null;
}
```

- [ ] **Step 4: Implement TeamRuntime wrapper**

`TeamRuntime` creates and owns:

- `ApiClient` with team credentials;
- `Poller` with `teamId`, `teamName`, API client, notifier context, and global settings;
- per-team pause/resume state.

- [ ] **Step 5: Refactor Poller constructor**

Update `src/controllers/poller.ts` so all team-specific state is instance state and constructor accepts:

```ts
export interface TeamPollerContext {
  teamId: number;
  teamName: string;
  apiClient: ApiClient;
  lineGroupId: string;
}
```

Every repository/notifier call inside `Poller` must pass `teamId`.

- [ ] **Step 6: Replace global poller control**

Update `src/services/poller-control.ts` from a single object to a small per-team registry used by runtimes:

```ts
const pausedTeams = new Set<number>();
export function isTeamPaused(teamId: number): boolean;
export function pauseTeam(teamId: number): void;
export function resumeTeam(teamId: number): void;
```

- [ ] **Step 7: Start runtime manager from app entrypoint**

Update `src/app.ts`:

- ensure dashboard tables;
- ensure default admin;
- ensure Default Team from legacy settings;
- migrate settings;
- create/start `TeamRuntimeManager`;
- start HTTP server with controller access to runtime manager if needed.

- [ ] **Step 8: Run runtime tests**

Run: `npm test -- team-runtime-manager`

Expected: PASS.

Run: `npm test -- poller-fast-lane`

Expected: PASS after updating test construction to include `teamId` and fake `ApiClient` credentials.

Run: `npm test -- poller-streaming-early-accept`

Expected: PASS after updating call sites to include team context.

---

### Task 8: Team-Scoped Metrics, SSE, and Operational Controls

**Files:**

- Modify: `src/services/metrics.ts`
- Modify: `src/repositories/metrics-repository.ts`
- Modify: `src/services/sse.ts`
- Modify: `src/controllers/dashboard-controller.ts`
- Modify: `src/services/http-server.ts`
- Modify: `src/frontend/hooks/useSseContext.tsx`
- Modify: `src/frontend/hooks/useSse.ts`
- Modify: `src/frontend/types/index.ts`

- [ ] **Step 1: Add metrics teamId types**

Update backend and frontend metric snapshot types with:

```ts
teamId: number | null;
teamName?: string;
```

Use `null` only for admin aggregate snapshots. User snapshots must include a numeric team id.

- [ ] **Step 2: Update persisted metrics**

Make `metrics_snapshots.team_id` required and store per-team metrics. Add list functions that accept `teamId` for users and optional explicit admin `teamId` for admin views.

- [ ] **Step 3: Update SSE event envelope**

Use an envelope shape:

```ts
export interface TeamSseEvent<T> {
  teamId: number;
  event: string;
  data: T;
}
```

Filter server-side for user connections so users only receive their own team's events.

- [ ] **Step 4: Update operational controls**

Change `/system/pause` and `/system/resume` behavior:

- user request pauses/resumes own team only if this control remains user-accessible;
- admin request requires explicit `teamId` for one team;
- admin `restart-all` lives under `/api/teams/restart-all`.

- [ ] **Step 5: Run dashboard and metrics tests**

Run: `npm test -- metrics`

Expected: PASS after metric test fixtures include `teamId`.

Run: `npm test -- dashboard-readiness`

Expected: PASS after readiness logic accounts for team runtime statuses.

---

### Task 9: Frontend Types, API Client, and Teams Admin Page

**Files:**

- Create: `src/frontend/routes/teams.tsx`
- Modify: `src/frontend/types/index.ts`
- Modify: `src/frontend/lib/api.ts`
- Modify: `src/frontend/components/layout/AppLayout.tsx`

- [ ] **Step 1: Add frontend team types**

Update `src/frontend/types/index.ts`:

```ts
export interface Team {
  id: number;
  name: string;
  enabled: boolean;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
  hasLineGroupId: boolean;
  spxCookiePreview: string;
  spxDeviceIdPreview: string;
  lineGroupIdPreview: string;
  runtimeStatus?: 'stopped' | 'running' | 'paused' | 'misconfigured' | 'session_expired' | 'error';
  usersCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
}
```

Extend `AuthUser` and `User` with `teamId` and `teamName`.

- [ ] **Step 2: Add teamsApi**

Update `src/frontend/lib/api.ts`:

```ts
export const teamsApi = {
  list: (): Promise<Team[]> => fetchJson<Team[]>(`${API_BASE}/teams`),
  get: (id: number): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams/${id}`),
  create: (team: TeamInput): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams`, { method: 'POST', body: JSON.stringify(team) }),
  update: (id: number, team: Partial<TeamInput>): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams/${id}`, { method: 'PUT', body: JSON.stringify(team) }),
  disable: (id: number): Promise<null> => fetchJson<null>(`${API_BASE}/teams/${id}/disable`, { method: 'POST', body: JSON.stringify({}) }),
  restart: (id: number): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams/${id}/restart-poller`, { method: 'POST', body: JSON.stringify({}) }),
  pause: (id: number): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams/${id}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  resume: (id: number): Promise<Team> => fetchJson<Team>(`${API_BASE}/teams/${id}/resume`, { method: 'POST', body: JSON.stringify({}) }),
  restartAll: (): Promise<Team[]> => fetchJson<Team[]>(`${API_BASE}/teams/restart-all`, { method: 'POST', body: JSON.stringify({}) }),
}
```

- [ ] **Step 3: Add Teams navigation**

Update `AppLayout.tsx` admin nav with `Teams` using `Users` or `Truck` icon. Add `/teams` to `pageLabels`.

- [ ] **Step 4: Implement Teams page**

Create `src/frontend/routes/teams.tsx` with:

- table of teams;
- create/edit dialog;
- enabled switch;
- secret inputs for cookie/device/LINE group;
- status pills for configured/missing and runtime status;
- restart, pause/resume, disable actions;
- query invalidation after mutations.

Use existing UI primitives from `users.tsx`: `Card`, `Button`, `Input`, `Label`, `Dialog`, `PageHeader`, `ErrorState`, `SkeletonTable`, `toast`.

- [ ] **Step 5: Run frontend typecheck**

Run: `npm run typecheck:frontend`

Expected: PASS after TanStack Router detects the new route. If `routeTree.gen.ts` changes through the Vite/router plugin, accept generated changes only if produced by the normal build/typecheck flow; do not edit it manually.

---

### Task 10: Users UI Team Assignment and Global Settings Cleanup

**Files:**

- Modify: `src/frontend/routes/users.tsx`
- Modify: `src/frontend/types/index.ts`
- Modify: `src/frontend/lib/api.ts`
- Modify: `src/frontend/lib/settings-shared.tsx`
- Modify: `src/frontend/routes/settings.api.tsx`
- Modify: `src/frontend/routes/settings.notifications.tsx`
- Modify: `src/frontend/routes/settings.line-bot.tsx`
- Modify: `src/controllers/settings-controller.ts`

- [ ] **Step 1: Update user payload types**

Update `CreateUserInput` and `RoleInput`:

```ts
export interface CreateUserInput {
  username: string;
  password: string;
  role?: 'user' | 'admin';
  teamId?: number | null;
}

export interface RoleInput {
  role: 'user' | 'admin';
  teamId?: number | null;
}
```

Add `updateTeam` API if role and team are separate in backend:

```ts
updateTeam: (id: number, teamId: number | null): Promise<null> =>
  fetchJson<null>(`${API_BASE}/users/${id}/team`, { method: 'PUT', body: JSON.stringify({ teamId }) })
```

- [ ] **Step 2: Load teams in Users page**

In `users.tsx`, add `useQuery({ queryKey: ['teams'], queryFn: teamsApi.list })` and pass teams into create/edit dialogs.

- [ ] **Step 3: Require team when role is user**

In create and role/team edit dialogs:

- if selected role is `user`, require a team id;
- if selected role is `admin`, allow no team;
- show current team in users table.

- [ ] **Step 4: Remove team-specific settings from global settings UI**

Remove from frontend settings form and settings routes:

```text
COOKIE
DEVICE_ID
LINE_USER_ID
LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS
LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE
```

Keep global LINE token/session fields:

```text
LINE_CHANNEL_ACCESS_TOKEN
LINEJS_TEST_ENABLED
LINEJS_TEST_DEVICE
LINEJS_TEST_STORAGE_PATH
```

- [ ] **Step 5: Block team-specific setting writes on backend**

Update `settings-controller.ts` or `settings.ts` validation so attempts to write removed team-specific keys are ignored or rejected with a 400. Prefer rejection for new API clients and preserve migration read-only compatibility internally.

- [ ] **Step 6: Run focused frontend checks**

Run: `npm run typecheck:frontend`

Expected: PASS.

Run: `npm test -- settings-validation`

Expected: PASS after settings-shared fields are updated.

---

### Task 11: End-to-End Wiring and Backward Compatibility Pass

**Files:**

- Modify files from Tasks 1-10 only if integration reveals mismatches.
- Modify docs only if operator requests docs beyond the accepted spec and this plan.

- [ ] **Step 1: Run all standalone tests**

Run: `npm test`

Expected: PASS. If failures are due to old helper signatures, update the test fixtures to include `teamId` and preserve the old behavior inside one team.

- [ ] **Step 2: Run backend typecheck**

Run: `npm run typecheck:backend`

Expected: PASS.

- [ ] **Step 3: Run frontend typecheck**

Run: `npm run typecheck:frontend`

Expected: PASS.

- [ ] **Step 4: Run production build**

Run: `npm run build`

Expected: PASS and Vite build completes.

- [ ] **Step 5: Run diff hygiene checks**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only files intentionally touched by this plan plus any generated route tree produced by the normal build. Do not include unrelated pre-existing `package.json` or `package-lock.json` changes unless operator approved them.

- [ ] **Step 6: Manual verification checklist**

Use memory DB or a local dev DB with safe test data:

- admin can create team A and team B;
- admin can set cookie/device/LINE group for each team and secrets are redacted after save;
- admin can create user A in team A and user B in team B;
- user A can create rules and only sees team A rules;
- user B can create rules and only sees team B rules;
- the same `request_id` can exist in history for team A and team B;
- team A session-expired state pauses only team A runtime;
- missing LINE group skips notification but does not fail auto-accept;
- admin restart for team A does not restart team B;
- admin restart-all affects all running teams;
- user cannot call `/api/teams`, `/api/settings`, or `/api/users`.

- [ ] **Step 7: Stop before commit/deploy**

Do not commit, push, or deploy. Report verification evidence and ask the operator whether they want a commit or deployment workflow.

---

## Self-Review Checklist for the Implementer

- [ ] Spec coverage: every section in `docs/superpowers/specs/2026-06-16-multi-team-runtime-design.md` maps to at least one task above.
- [ ] Migration drift guard: `src/db/schema.ts`, `src/db/client.ts`, `src/db/client-memory.ts`, `migrations/018_multi_team_runtime.sql`, and `src/repositories/metrics-repository.ts` agree.
- [ ] Team leakage guard: every team-owned repository function requires `teamId` explicitly.
- [ ] Auth guard: user role cannot exist without `teamId`; admin may have `teamId = null`.
- [ ] Secret guard: raw `spx_cookie`, `spx_device_id`, and `line_group_id` never appear in API responses.
- [ ] Runtime guard: a broken team runtime cannot crash or pause other team runtimes.
- [ ] Verification guard: `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` are run before completion claims.
