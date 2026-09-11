# Team Provider Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace manual provider Cookie/Device ID entry with per-team stored Email/Password, HTTP login, and safe automatic session renewal.

**Architecture:** A dedicated provider-auth repository controls encrypted account/session fields and a fenced lease on the existing team row. A browser-free HTTP adapter handles provider protocol; a session service connects it to scoped APIs and dynamic poller credentials. A shared UI panel exposes account/status operations to own-team users and admins.

**Tech Stack:** Node >=24.16.0, TypeScript, Fastify 5, Drizzle/MySQL with SQLite memory tests, Undici fetch, tough-cookie, React 19, TanStack Query, standalone tsx assertion tests.

**Spec:** `docs/superpowers/specs/2026-09-11-team-provider-auth-design.md`

## Global Constraints

- Work in the existing workspace; no branch, commit, push, production deployment, or live migration is authorized.
- Never read or change `.env`, existing secret files, `notify-rules.json`, generated routeTree, or unrelated work.
- Never put live credentials in code, fixtures, logs, plan documents, API responses, or Memory Vault.
- Backend code uses strict TypeScript and `.js` relative imports; frontend follows existing React styles and Thai UI copy.
- Tests use the repository's standalone `node:assert` / tsx runner with `DB_MODE=memory`; no real provider accounts or business transactions in tests.
- Existing manually supplied Cookie/Device ID remain usable during migration.
- User credential routes derive the team ID from the authenticated user; admin routes check admin role.
- Cookie and Device ID become visible to consumers as a pair only after successful identity verification.
- Authentication renewal never enables, resumes, or restarts a stopped/paused team and never replays booking-accept mutations.
- Stop implementation at focused tests and `npm run typecheck` passing; do not auto-commit or auto-deploy.

## Task 1: Encrypted team account storage and fenced auth operations

**Files:** Create `src/models/provider-auth.ts`, `src/repositories/team-provider-auth-repository.ts`, `migrations/040_add_team_provider_auth.sql`, `tests/team-provider-auth-repository.test.ts`, `tests/team-provider-auth-schema.test.ts`. Modify `src/db/schema.ts`, `src/db/client.ts`, `src/db/client-memory.ts`, `scripts/schema-verify.mjs`, `src/repositories/team-repository.ts`.

**Interfaces:** Define shared public/secret types and export repository functions with these signatures. Dates returned as ISO strings/null; lease ownership lives only in the backend.

```ts
type ProviderAuthState = 'manual' | 'connected' | 'connecting' | 'attention' | 'retry_wait';
type ProviderAuthErrorCode = 'invalid_credentials' | 'challenge_required' | 'rate_limited' | 'provider_unavailable' | 'invalid_response' | 'invalid_input' | 'session_expired' | 'busy' | 'not_configured' | 'stale_operation';
interface ProviderCredentials { email: string; password: string }
interface ProviderSession { cookie: string; deviceId: string; expiresAt: string | null }
interface ProviderAuthStatus { teamId: number; email: string; hasPassword: boolean; status: ProviderAuthState; lastLoginAt: string | null; expiresAt: string | null; errorCode: ProviderAuthErrorCode | null; retryAt: string | null }
interface ProviderAuthRecord extends ProviderAuthStatus { password: string; cookie: string; deviceId: string; epoch: number; failures: number; enabled: boolean }
interface ProviderAuthLease { teamId: number; token: string; epoch: number }
getTeamProviderAuth(teamId: number): Promise<ProviderAuthRecord | null>;
getTeamProviderAuthStatus(teamId: number): Promise<ProviderAuthStatus | null>;
acquireTeamProviderAuthLease(teamId: number, now?: Date): Promise<ProviderAuthLease | null>;
commitTeamProviderAuth(lease: ProviderAuthLease, credentials: ProviderCredentials, session: ProviderSession, now?: Date): Promise<boolean>;
failTeamProviderAuth(lease: ProviderAuthLease, failure: {status: ProviderAuthState; errorCode: ProviderAuthErrorCode; retryAt: string | null; failures: number}, now?: Date): Promise<boolean>;
```

- [x] Write RED tests using real memory DB, synthetic secrets and explicit clocks. Include successful encrypted commit, missing team, competing leases, expiry, stale epoch, DTO secrecy, failed replacement preservation and manual override invalidation.

```ts
const first = await acquireTeamProviderAuthLease(team.id, clock);
assert.ok(first);
assert.equal(await acquireTeamProviderAuthLease(team.id, clock), null);
assert.equal(await commitTeamProviderAuth(first, { email: 'team@example.test', password: 'fixture-password' }, {cookie:'fixture-cookie',deviceId:'fixture-device',expiresAt:null}, clock), true);
assert.equal((await getTeamProviderAuthStatus(team.id))?.hasPassword, true);
assert.equal('password' in (await getTeamProviderAuthStatus(team.id))!, false);
```

- [x] Run `npm test -- team-provider-auth` and record the meaningful missing-feature failure.
- [x] Add the spec's fields to all schema representations. Use existing encryption helpers and parameterized Drizzle conditional updates. Check affected-row count and reread lease ownership; never use a non-atomic read-then-write lock. Keep new secrets out of TeamRuntimeConfig/RedactedTeam. Manual secret updates invalidate auth only when the submitted value is an actual replacement, not the existing redacted placeholder.
- [x] Run the new tests plus `npm test -- team-repository`, `npm test -- schema-consistency`, and backend typecheck. Report changed files and RED/GREEN evidence without committing.

## Task 2: Browser-free provider protocol and session lifecycle

**Files:** Create `src/services/provider-auth/client.ts`, `src/services/provider-auth/session-service.ts`, `tests/provider-auth-client.test.ts`, `tests/provider-auth-session.test.ts`. Modify `package.json` and `package-lock.json` only to add `tough-cookie` as a production dependency.

**Interfaces:** Consume Task 1 shared types/repository. Export `ProviderAuthError` with a safe code and nullable retryAfterMs, `loginProvider(credentials, {deviceId?, signal?, fetch?})`, `checkProviderSession(session, {signal?, fetch?})`, `createProviderAuthService(deps?)` and a default `providerAuthService`. Service methods: `connect(teamId, credentials)`, `reconnect(teamId)`, `ensure(teamId)` returning `ProviderAuthRecord|null`, and `recover(teamId, rejectedEpoch)` returning boolean. `checkProviderSession` returns `valid | expired | unavailable` with safe error details; never raw bodies. Use dependency injection for repository, client and clock so lifecycle tests do not contact the provider.

- [x] Write RED tests against a fake Fetch implementation that handles the five fixed requests and records payload/header metadata. Test cookie isolation, exact password hashing and success verification, then rejection/error cases from the spec.

```ts
const result = await loginProvider({email:'team@example.test',password:'fixture-password'}, {fetch: fakeProviderFetch});
assert.match(result.cookie, /spx_uk=fixture-session/);
assert.equal(result.deviceId.length, 32);
assert.equal(requests.filter(r => r.url.endsWith('/business/login')).length, 1);
assert.equal(requests.every(r => !r.url.includes('fixture-password')), true);
```

- [x] Run `npm test -- provider-auth-client` to observe RED. Install `tough-cookie`; consult current Context7 CookieJar docs. Implement the fixed-host HTTP chain with one 45-second AbortSignal deadline, redirect bounds, response-size bounds, safe parsing and no login retries. No Playwright runtime dependency. Do not copy live state or secret values from the prototype.
- [x] Implement lifecycle from RED tests: refresh at five-minute expiry margin; persist/reuse existing device ID; per-process single flight plus DB lease; no automatic auth without saved credentials; confirm identity before reactive auth; reload advanced epoch; bounded cooldown; preserve old credentials on failed candidate replacement; safe failure finalization.

```ts
await Promise.all([service.recover(teamId, oldEpoch), service.recover(teamId, oldEpoch)]);
assert.equal(loginCalls, 1);
assert.equal((await repository.getTeamProviderAuth(teamId))?.epoch, oldEpoch + 1);
```

- [x] Run protocol/lifecycle tests and backend typecheck. Report public error mappings grounded in the supplied public frontend enum source; unknown errors must fail safely, not trigger login loops.

Add neutral releaseTeamProviderAuthLease(lease, now?) and preservation tests to the shared repository for post-acquisition suppression; require positive affected-row results. This is the execution refinement recorded in the SDD ledger.

## Task 3: Scoped HTTP endpoints and live runtime session updates

**Files:** Create `src/controllers/provider-auth-controller.ts`, `src/services/provider-auth/runtime-session.ts`, `tests/provider-auth-controller.test.ts`, `tests/provider-auth-runtime.test.ts`. Modify `src/services/http-server.ts`, `src/services/team-runtime.ts`, `src/controllers/poller.ts`, and only necessary team manager/repository integration points.

**Interfaces:** Consume Task 2 default/injected auth service. Export scoped Fastify controller factories for own-team and admin resources. Export `createTeamRuntimeSession(teamId, initialCredentials, deps?)` with `credentials()` synchronous pair, `beforePoll():Promise<boolean>`, `recover():Promise<boolean>`, `dispose():void`. Add optional `beforePoll` and `onSessionRejected` callbacks to TeamPollerContext, preserving behavior when absent.

- [x] RED controller tests use Fastify inject with stub auth service, enforce body schema/limits and deny anonymous/viewer/cross-team access. Use safe status-only output and safe audit events. Map busy to 409, rate limit/cooldown to 429, malformed input to 400, unknown provider failure to 502; no raw exception messages.

```ts
const response = await app.inject({method:'PUT',url:'/api/team/provider-auth',payload:{email:'team@example.test',password:'fixture-password',teamId:otherTeam.id}});
assert.equal(response.statusCode, 400);
assert.equal(authCalls.length, 0);
```

- [x] Implement GET/PUT `/api/team/provider-auth`, POST `/api/team/provider-auth/reconnect`, and admin equivalents under `/api/teams/:id/provider-auth`. Derive own-team ID via requireTeamUser and mount inside existing role scopes. Do not call restartTeam/resumeTeam after credential changes.
- [x] RED runtime tests prove cached pair replacement after five seconds, reactive epoch freshness, no manual-mode login, no background work after disposal, no automatic retry of accept methods, and no polling when session unavailable. Implement dynamic credentialsProvider in TeamRuntime and callbacks before the list fetch and after candidate session errors. Calls after rejection return to the normal read-poll loop; they do not replay write operations.

```ts
const previous = holder.credentials();
await holder.beforePoll();
assert.notDeepEqual(holder.credentials(), previous);
assert.equal(restartCalls, 0);
holder.dispose();
assert.equal(await holder.beforePoll(), false);
```

- [x] Ensure stopped/paused team behavior remains covered by current-team/team-runtime tests. Run `npm test -- provider-auth`, `npm test -- current-team`, `npm test -- team-runtime`, `npm test -- api-client-team`, and backend typecheck. Fix relevant failures only.

## Task 4: Team account UI and self-service integration

**Files:** Create `src/frontend/components/ProviderAuthPanel.tsx`, `tests/frontend-provider-auth.test.ts`. Modify `src/frontend/types/index.ts`, `src/frontend/lib/api.ts`, `src/frontend/routes/index.tsx`, `src/frontend/routes/teams.tsx`, and a focused UI fixture/smoke test if needed. Never hand-edit routeTree.gen.ts.

**Interfaces:** Public `ProviderAuthStatus` mirrors Task 1; `providerAuthApi.get(teamId?)`, `.connect(credentials, teamId?)`, `.reconnect(teamId?)` map to own-team/admin resources. A `teamId` prop is passed only for an admin-selected team. Panel writes password only through connect mutation and clears it on success/close.

- [x] Add failing contract tests for endpoint selection, request bodies, no password in query keys/localStorage, and validation of password replacement. Follow current frontend test patterns; extract pure form helpers only where behavior merits tests.
- [x] Add Thai UI: Email, Password, saved-password indicator, connect/replace, reconnect, account/session status, last login and expiry, in-flight/429/attention handling. Existing design tokens and components apply. Account settings must be available to an own-team user from the dashboard and to admins for each team.

```tsx
<Input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
<Button disabled={isPending || !email.trim() || !password} onClick={connect}>เชื่อมต่อบัญชี</Button>
```

- [x] Remove the forced Cookie/Device ID requirement for creating a team; provide account connection on the created team's page/dialog. Keep manual input in a clearly labeled legacy/advanced section. Preserve all other team notification/vehicle/runtime settings.
- [x] Run `npm test -- frontend-provider-auth`, existing frontend team control/actions tests, and frontend typecheck. Run a local fixture-based browser smoke check of connect/error/reconnect and check responsive layout; do not submit any live credentials. Include screenshot evidence if the fixture supports it.

## Task 5: Integrated review and completion

**Files:** Update this plan and the spec with actual implementation choices; add `docs/runbooks/team-provider-auth.md` for operational use if no existing equivalent exists. Review only task-owned changes against the recorded starting baseline, including new files.

- [x] Review each task's diff with its tests and fix consequential findings before proceeding. Review full feature for secret leaks, tenant isolation, lease/cooldown races, API/UI contract mismatch, migration parity and preserved run intent.
- [x] Run combined focused feature/regression tests, `npm run typecheck`, and `git diff --check` on changed files. No unrelated broad suites unless new evidence justifies them. Local MySQL migration execution is not claimed without an isolated test database.
- [x] Document migration 040, encrypted credential key requirement, initial/manual migration behavior, password changes, cooldown/challenge handling and the scope of actual verification. Tests must never use the previously supplied real account.
- [x] Update task checkboxes and progress ledger, write project-memory sessionEnd with verify true, and deliver concise Thai summary with file links. Leave changes uncommitted and undeployed.

Final review outcome: all original R1–R5 findings addressed; no remaining Critical/Important finding in the single scoped final re-review. One Minor message-precedence edge after a timed-out status read is documented in the runbook with a panel-reopen workaround and retained as a follow-up. Verification covered 18 distinct selected test files and passed frontend/strict tracked-backend checks; full workspace typecheck remains at the identical 68 unrelated baseline diagnostics. No live migration, production build, commit or deployment was performed.
