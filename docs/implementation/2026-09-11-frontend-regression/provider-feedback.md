# Provider feedback precedence regression

## Cause

After a provider mutation failed, `ProviderAuthPanel` stored the already-rendered request copy and displayed it before `status.errorCode`. If the automatic status GET timed out, that request copy remained. A later explicit successful GET could confirm `challenge_required`, but the alert still showed the stale generic credential message because `requestError || statusError` always selected the earlier request copy.

## Fix

The panel now stores each request error code with the successful-status-read revision observed when that mutation failed. `selectProviderAuthFeedbackCode` gives `DASHBOARD_AUTH_REAUTH_REQUIRED` highest priority, uses a new request error while the visible status is still cached, and lets provider status win only after a successful post-request GET confirms it (`src/frontend/components/ProviderAuthPanel.tsx:84`, `src/frontend/components/ProviderAuthPanel.tsx:101`, `src/frontend/lib/provider-auth-feedback.ts:1`). A successful automatic or explicit status read clears the superseded request feedback; failed and timed-out reads do not. The existing cooldown, password clearing, mutation fencing, status-only retry, and no-replay paths were left intact.

## TDD evidence

- RED: `npx tsx tests/frontend-provider-auth-feedback.test.ts` exited 1 with `MODULE_NOT_FOUND` for the new feedback selector before production implementation.
- Behavioral mutation RED: temporarily restoring request-first precedence made the same test exit 1 with actual `PROVIDER_AUTH_FAILED` versus expected `challenge_required`, reproducing the stale-guidance bug. The correct implementation was then restored.
- Freshness RED: a cached `challenge_required` plus a new `PROVIDER_AUTH_RATE_LIMITED` failure initially returned the cached challenge. The test exited 1 until successful-read revision tracking distinguished cached status from newly confirmed status.
- GREEN: the same command exited 0 with `frontend-provider-auth-feedback: all assertions passed` after implementation.
- The focused test covers confirmed `challenge_required` replacing stale generic mutation guidance, cached status yielding to a new mutation failure, dashboard reauthentication retaining priority, request-only fallback, confirmed-clear state, and status-only feedback (`tests/frontend-provider-auth-feedback.test.ts:5`).

## Verification

- `npx tsx tests/frontend-provider-auth-feedback.test.ts` — exit 0.
- `npx tsx tests/frontend-provider-auth.test.ts` — exit 0.
- `npm run typecheck:frontend` — exit 0.
- `npx eslint src/frontend/components/ProviderAuthPanel.tsx src/frontend/lib/provider-auth-feedback.ts tests/frontend-provider-auth-feedback.test.ts` — exit 0 with no warnings after adding the missing `cancelRead` dependency.
- Browser automation was not launched in this task; the root task owns in-app CUA verification.

## Root CUA manual regression steps

1. Open the existing provider-auth fixture in the in-app browser and wait for the saved connected account.
2. In the fixture page context, run `window.__providerFixture.setScenario('challenge')` followed by `window.__providerFixture.holdNextRead()`.
3. Activate **เชื่อมต่ออีกครั้ง**. The mutation returns the generic `PROVIDER_AUTH_FAILED`, persists `challenge_required`, and starts the held status GET.
4. Allow the 10-second status-read deadline to expire, then run `window.__providerFixture.releaseRead()` and activate **ลองใหม่** for an explicit status GET.
5. Confirm the alert shows the provider challenge guidance containing **ยืนยันตัวตน** and no longer shows the stale generic copy **กรุณาตรวจสอบอีเมลและรหัสผ่าน**. Confirm the status pill is **ต้องตรวจสอบ** and reconnect remains under the persisted cooldown.
6. Capture the final panel state for the root visual record. The dashboard-auth priority branch is covered by the focused node assertion because the fixture does not expose a dashboard-401 scenario.
