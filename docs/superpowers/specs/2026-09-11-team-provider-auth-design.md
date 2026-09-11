# Team provider account and automatic session renewal

Status: approved direction; implementation authorized by the user on 2026-09-11.

## Goal and accepted decisions

Users enter their team's MyAgencyService email/password in SPX. SPX retains the email and encrypted recoverable password, obtains Logistics Cookie/Device ID through HTTP, and renews the session without asking users to copy browser cookies. This external account is distinct from the user's SPX dashboard login. The accepted storage ADR is `memory/04_Architecture_Decisions/store-myagencyservice-login-credentials-per-team-in-spx-with-encrypted-passwords.md`.

## Global constraints

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

## Architecture

Keep provider account/session fields on the existing `teams` row, so credential replacement and lease fencing can use one conditional SQL UPDATE in both MySQL and SQLite. Keep access to decrypted passwords in a dedicated repository/service; never add the password to TeamRuntimeConfig or RedactedTeam. Reuse authenticated encryption in `src/utils/crypto.ts`.

The HTTP adapter has no database or browser dependency. Use the existing Node/Undici fetch stack and a maintained CookieJar (`tough-cookie`) so HttpOnly, domain/path, expiry, and replacement rules are handled correctly. Restrict network destinations to Accounts and Logistics HTTPS hosts. Redirects are followed explicitly with host validation; credentials never enter URLs. Keep the complete authentication attempt under one 45-second deadline and no automatic password-submit retries.

The session service owns initial connection, reconnection and automatic renewal. Its database lease serializes these operations across processes. The worker's runtime session holder refreshes its cached credentials from the database at most once per five seconds. It supplies the current pair to ApiClient's existing synchronous credentialsProvider. A pre-poll hook performs renewal when due; a rejected-session hook confirms invalidity through the identity endpoint before requesting login. Legacy manual credentials continue polling without automatic login.

## Storage

Add migration `040_add_team_provider_auth.sql` after the currently highest migration 039; recheck numbering before writing. Add matching MySQL Drizzle, runtime MySQL DDL, SQLite DDL, and schema verification definitions. Do not edit released migrations/checksums.

New `teams` fields (all optional/defaulted for existing rows):

| TypeScript field | SQL column | Storage/default |
|---|---|---|
| spxEmail | spx_email | VARCHAR(254), empty |
| spxPassword | spx_password | TEXT, encrypted; nullable |
| spxAuthStatus | spx_auth_status | VARCHAR(24), manual |
| spxAuthError | spx_auth_error | VARCHAR(48), nullable safe code |
| spxAuthRetryAt | spx_auth_retry_at | DATETIME nullable, UTC |
| spxAuthFailures | spx_auth_failures | INT default 0 |
| spxSessionExpiresAt | spx_session_expires_at | DATETIME nullable, UTC |
| spxLastLoginAt | spx_last_login_at | DATETIME nullable, UTC |
| spxAuthEpoch | spx_auth_epoch | INT default 0 |
| spxAuthLeaseToken | spx_auth_lease_token | VARCHAR(64), nullable |
| spxAuthLeaseUntil | spx_auth_lease_until | DATETIME nullable, UTC |

Lease acquisition atomically updates an unlocked/expired row and returns its random token and current epoch. Lease TTL is 120 seconds, above the authentication attempt deadline. Success/failure writes require the same token, epoch, and unexpired lease. Only successful replacement increments epoch. Any legacy manual Cookie/Device ID edit invalidates an in-flight auth lease, increments epoch, and clears saved automatic-login credentials (manual mode); unrelated team edits do not. Failed candidate credentials leave the previous password, email, Cookie and Device ID untouched. Candidate failure may record a safe error and a short cooldown without permanently disabling the previous valid account.

If a post-acquisition reread determines that an operation must stop without failure (for example a concurrent manual override), release the lease through a token/epoch/expiry-fenced neutral update that does not change account or auth-status fields.

Public auth status contains teamId, email, hasPassword, status, lastLoginAt, expiresAt, errorCode, retryAt. Status values: manual, connected, connecting (derived from an active lease), attention, retry_wait. No secret values or suffix previews for passwords. Existing team list DTO may carry only email, hasPassword, status and expiry summaries.

## Verified provider protocol

The local throwaway proof `output/playwright/myagency-auth/http-only-login.mjs` established this on 2026-09-11. Read its source/verification only; do not read adjacent credential files. It used fresh CSRF, zero initial auth cookies, no browser launch or fingerprint reuse.

1. Generate a 32-character CSRF token; cookie `csrftoken` on Accounts and matching `x-csrftoken`, plus `x-app-type: 19`.
2. GET Accounts `/authenticate/login` with `client_id=15`, language and a Logistics `/auth/callback?refer=...` next URL.
3. POST Accounts `/api/v4/account/business/login_status` with `{}` to initialize server cookies. An unauthenticated status is expected; its error is not a password failure.
4. POST `/api/v4/account/business/login` with email, `SHA256(lowercaseHex(MD5(UTF8(password))))`, and empty captcha_signature/security_device_fingerprint. A successful response requires error 0, a nonempty nonce, and SPC_CLIENTID from the jar.
5. GET the fixed Logistics callback with the nonce as code, SPC_CLIENTID as spc_clientid, and the original SSO context. Accept bounded redirects only to the two allowed HTTPS hosts.
6. Select cookies for Logistics; use a stable existing Device ID when present, otherwise generate 32 random hex characters. Send it as both `device-id` and spx-admin-device-id cookie.
7. GET `/api/basicserver/agency/account/current_user/basic_info`. Require HTTP 200, retcode 0, a provider identity, and a matching email when returned. Extract the earliest persistent authentication-cookie expiry; unknown expiry is nullable, never treated as immediate failure.

The proof used app/CSRF/session initialization together; it did not isolate which individual header is mandatory. It proves feasibility for the observed provider behavior, not a permanent provider API contract.

## Lifecycle and failure policy

- Initial save/changed credentials: normalize and validate email, preserve password bytes, acquire lease, authenticate and verify, then atomically persist encrypted password and new session. Same-team concurrent attempts return a safe busy response.
- Automatic: only the active, unpaused team polling path renews. Refresh within five minutes of known expiry. Keep a valid old session if a proactive attempt fails transiently.
- Reactive: broad legacy 401/403/retcode classification is only a suspicion. Probe current identity first. HTTP 401 is confirmed expiry; rate limits, network errors, gateway 403 and malformed data do not cause a password login storm. A valid identity leaves the session unchanged. If another process already advanced epoch, load its session instead.
- Failed credentials or verification challenges: safe attention status, no automatic retries until user changes/reconnects. Unknown provider failures are sanitized. Initial invalid-input 10002 is never mislabeled as expired password/session by this adapter.
- Transient failures: exponential cooldown 30, 60, 120, 240, then 300 seconds; respect a bounded Retry-After. Manual repeated operations share the same persisted cooldown (at least 30 seconds after an attempt). No password brute-force loop.
- Always release/finalize leases on handled failure; unhandled process death recovers after expiry. Stale completions cannot overwrite newer sessions.
- A user/admin can manually reconnect, including while the team is stopped; reconnect changes credentials only, not team run intent.
- Public errors and audit events identify team, operation, and safe outcome only. Never include provider response bodies, cookies, password hashes, nonce URLs, or transport exception objects.

## API and UI

New own-team resource `/api/team/provider-auth`: GET status, PUT `{email,password}` connect/replace, POST `/reconnect`. New admin resource `/api/teams/:id/provider-auth` with the same operations. Password is required for a replacement; an empty field means no new credential submission in the UI, not erase-the-password. Validate body allowlists and sizes. Return safe status after successful operations, and appropriate safe 400/401/403/404/409/429/502 errors.

Add a reusable Thai account connection panel/dialog. On the user dashboard it manages only the current team. On the admin Teams page it manages the selected team. Show email, saved-password indicator, status, last successful login, expiry, connect/change and reconnect actions. Password input starts blank every opening, is never prefilled from a response, and clears on success or dismissal. Disable duplicate submissions and explain cooldown/challenge/errors. Keep manual Cookie/Device ID controls under an explicitly labeled advanced/legacy option. A newly created team may exist without credentials so the account can be connected next; no business work starts until credentials are valid and the existing enabled/run controls permit it.

## Acceptance tests

1. HTTP fake server proves full bootstrap/login/callback/verification, hashing, cookie scoping, expiry and no browser usage.
2. Failed login, challenge, rate-limit, 403 gateway, redirect to another host, malformed response and wrong returned identity never produce saved credentials.
3. Raw database has encrypted password/cookie; public DTO and error/audit payloads omit all secrets.
4. Two simulated owners acquire at most one team lease; different teams proceed independently; stale epoch/token/expired lease cannot commit.
5. Failed candidate replacement preserves the prior account/session; legacy manual replacement fences old refresh and exits auto mode.
6. Automatic refresh swaps the active runtime pair without restarting it, respects paused/stopped/disabled intent, and coalesces simultaneous rejections.
7. Existing session validated as healthy or provider 403/network/rate-limit failure never triggers an unnecessary login; confirmed 401 does.
8. Read polling resumes with the new session; accept mutations are never automatically replayed.
9. Own-team user cannot modify another team; viewer/unauthenticated access is denied; admin has explicit selected-team authority.
10. UI connection, blank password handling, failed replacement, cooldown, reconnect and legacy team compatibility are verified with fixtures.

## Rollout and completion

Apply only local code in this task. Ship the additive migration and document how to apply it through the normal deployment process, but do not run it against a live database. Existing teams remain manual until a successful account connection. Retain existing stopped/paused behavior. Finish after focused feature/regression tests and typecheck pass; record limitations such as unexecuted real MySQL migration and live OTP/challenge flows honestly.

## Implementation refinements and verification limits

The implemented Teams dialog omits unchanged legacy fields on edit, including initially empty previews. This preserves accounts connected after the dialog opened while retaining intentional manual replacement/clearing. Final identity verification also validates the applicable nonempty authentication cookie and agreement between the device cookie and verified request/returned Device ID; inconsistent provider rotation fails safely.

The account panel reloads safe public status after handled provider failures. Connecting status uses bounded sequential reads, with an explicit retry after exhaustion, a deadline per read, and request/scope fencing. A dashboard-authentication refresh can recover safe reads but never automatically replay a credential mutation. Provider-account failures do not use dashboard HTTP 401. The existing successful-manual-operation cooldown is derived from `lastLoginAt + 30 seconds` together with persisted `retryAt` and server rate-limit metadata.

The whole-workspace TypeScript gate has 68 pre-existing diagnostics in 19 unrelated untracked backend roots. Execution therefore preserves those files and records an exact final diagnostic comparison, alongside a passing strict gate for all tracked backend roots plus the new feature roots and a separate frontend typecheck. This is the scoped verification ruling recorded in the execution ledger, not a passing full-workspace build. Synthetic memory/browser tests do not establish live MySQL migration or production-provider challenge behavior.
