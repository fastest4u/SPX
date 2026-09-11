# Team provider login and session renewal

SPX can retain a separate MyAgencyService account for each team, log in through HTTP, and renew its Logistics session. The provider account is separate from the SPX dashboard account. Existing teams remain in manual Cookie/Device ID mode until an account is connected successfully.

## Connecting a team

An own-team user manages the provider account from the dashboard. An administrator manages it from the selected team's account panel on Teams. Enter the provider email and password and connect. SPX verifies the returned identity before replacing the team's saved account and Cookie/Device ID pair. A failed replacement preserves the previous account and session.

The password input is write-only. To replace an account, enter its password again; a blank password is not a request to erase the saved password. Reconnect uses the saved account. Connecting or reconnecting does not enable, resume, or restart a team; the existing team controls retain that responsibility.

Legacy Cookie/Device ID fields remain under advanced/manual settings. Submitting an actual replacement or explicitly clearing those fields clears automatic-login credentials and fences any in-flight renewal. An edit sends those fields only when they changed, so an untouched empty or redacted form cannot disconnect an account connected after the dialog opened. Changing unrelated team settings preserves the saved account.

## Session behavior

An active, unpaused poller renews within five minutes of known expiry. An unknown expiry is allowed; a rejected request then triggers an identity check. Confirmed expiry can trigger one login. Gateway 403, rate limits, network failures, and malformed responses do not by themselves establish expired credentials. Renewal updates the credentials used by future requests without replaying booking-accept operations.

A database lease lasts 120 seconds and fences completion by token, account epoch, and expiry. One authentication attempt has a 45-second overall deadline. In-process calls coalesce; the database lease serializes separate workers. Runtime credentials refresh from the database on a five-second cache interval.

Transient failures use 30, 60, 120, 240, then 300-second cooldowns, with bounded Retry-After support. A successful manual login also has a 30-second cooldown from `lastLoginAt`; the interface combines that with any later `retryAt`. A password error or challenge requires user attention; SPX does not automatically solve CAPTCHA/OTP or repeatedly submit the password.

## Status and API

| Status | Meaning |
|---|---|
| manual | Existing manually supplied session; no saved automatic-login account |
| connecting | An authentication operation currently owns the team's lease |
| connected | A provider session was verified and saved |
| retry_wait | A transient failure/cooldown is delaying another attempt |
| attention | Credentials or an interactive provider check need attention |

Own-team resources derive the team from the authenticated user:

- `GET /api/team/provider-auth`: public account/session status.
- `PUT /api/team/provider-auth`: connect/replace with `{email,password}`.
- `POST /api/team/provider-auth/reconnect`: reconnect the saved account.

Administrator equivalents use `/api/teams/:id/provider-auth`. Responses contain status metadata only, never passwords, password hashes, cookies, Device ID, lease tokens, or provider response bodies. Do not place real credentials in command history or example fixtures.

Provider account failures use safe domain errors rather than dashboard-authentication HTTP 401. Busy operations return 409; rate limits/cooldowns return 429 with `Retry-After` and `details.retryAfterMs`; invalid credentials/challenges return 400; provider transport/response uncertainty returns 502. The frontend should translate these codes into Thai recovery guidance and honor the delay without automatically replaying a credential submission.

An actual dashboard HTTP 401 follows SPX login recovery. Safe status reads may refresh the dashboard session and retry. A connect/reconnect action may refresh that dashboard session but requires explicit resubmission; its provider credential request is never replayed automatically.

After a provider operation fails, the panel reloads safe public status so the persisted attention/retry state and cooldown are visible. A displayed connecting state triggers bounded status checks; when that limit is reached, the panel offers an explicit status-check action. Status reads have a deadline and ignore responses from a closed panel or a previously selected team. These reads never resubmit provider credentials. For a provider challenge, complete the required verification with MyAgencyService, then reconnect.

After a successful status read, newly confirmed provider guidance replaces older request feedback. A cached challenge cannot mask a newer request failure; dashboard-session reauthentication remains the highest-priority recovery action. Retrying a status read never replays a login or changes saved credentials.

## Storage and rollout

Migration `040_add_team_provider_auth.sql` adds account, expiry, cooldown, and lease columns to `teams`. Apply through the normal authorized migration process (`npm run db:migrate`) before starting updated API/worker processes, and use `npm run schema:verify` for a read-only drift check. The migration runner applies all pending SQL files, so deployment review must cover that complete set. These commands use the configured database; they are not part of the local fixture tests.

The password and session secrets use the repository's AES-256-GCM encryption helper. All application roles that read/write them must share the same existing encryption key configuration. Preserve that key when restoring a database backup. Changing it without re-encrypting existing values requires reconnecting affected accounts. This feature does not modify environment files or introduce a plaintext-password migration.

The provider flow uses fixed Accounts/Logistics HTTPS destinations, CSRF initialization, the observed password digest format, SSO callback cookies, and an identity check. It is an integration with observed provider behavior, not a guaranteed public API contract. The HTTP-only feasibility proof was verified on 2026-09-11; implementation tests use synthetic requests and never submit live credentials or business transactions.

## Local verification

Run `npm test -- provider-auth` for the storage, protocol, lifecycle, controller, runtime, and frontend feature checks. Run `npm run typecheck` for backend/frontend compatibility. The test runner sets `DB_MODE=memory`; no live MySQL migration is exercised. The implementation report records browser fixture coverage and any remaining validation limits.

The scoped PR review ran in an isolated checkout without the unrelated A3 work. Full backend/frontend typecheck, production build, and lint passed. The complete test run passed 115 of 116 files; its browser startup timeout was fixed, and the affected provider browser suite then passed. The runner also includes the TSX accessibility test. See the [review report](../implementation/2026-09-11-spx-review/review.md) for findings, regression coverage, and CI evidence. Live MySQL migration and real-provider validation remain outside the synthetic test coverage.
