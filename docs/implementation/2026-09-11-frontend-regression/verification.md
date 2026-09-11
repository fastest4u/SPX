# Full-system frontend regression — 2026-09-11

The 14 frontend screens were inspected in the in-app Chromium browser with current workspace source and isolated synthetic APIs at `http://127.0.0.1:4180/`. The ordered [canvas](http://127.0.0.1:4180/output/verification/2026-09-11-frontend-regression/canvas.html) contains fresh screenshots and scope notes. This verifies the frontend cases below, not production end-to-end behavior or every browser/device combination.

## Corrections delivered in this pass

1. **Settings initialization and edits:** withhold the entire settings form and save controls until a successful server read; show retry on initial failure. Preserve dirty edits against background refetch and preserve edits made during an in-flight save. Reducer/provider tests verify these transitions.
2. **Mobile save bar:** the animated `PageShell` transform made its fixed child use the long form as containing block. The save button was measured near y=3953 outside the 844 px viewport. Render the bar through a body portal and place it above the global mobile navigation, including safe-area offset. Browser verification showed the bar at y=724–788 above navigation at 788–844; saving succeeded.
3. **Small-phone Dashboard:** telemetry badges overflowed to x=369 in a 312 px content area at a 320 px viewport. Allow the header/badges to wrap. After correction, main `scrollWidth` and `clientWidth` both equal 312.
4. **Navigation and keyboard:** use shared Dialog for the mobile drawer and Quick Search; trap focus and restore it after Escape. Keep full mobile navigation labels even after the desktop sidebar has been collapsed. Sortable table headers are real buttons with `aria-sort`; row checkbox names include row identity. History search/filter controls have accessible names.
5. **Read failures:** Dashboard, LINE status/groups, Audit, Auto Accept History, Runsheets and dependent team/group/filter reads expose explicit errors/retry. Do not show false healthy/disabled/empty values after failed initial reads. Paginated history pages can retain already-confirmed cached rows on background refetch failure; this branch was reviewed in source but not exercised for every page in the browser.
6. **Dependent writes:** user/team-dependent forms disable selection/submission until team membership can be confirmed; retry preserves drafts. The browser team-list failure/recovery case retained `preserved-draft`.
7. **Provider feedback:** distinguish a fresh request failure from cached provider status by successful-read revision. Newly confirmed challenge status replaces stale generic request copy; old challenge state cannot mask a new rate-limit failure. Dashboard reauthentication remains highest priority. See `provider-feedback.md` and the focused behavioral tests.
8. **Configured API paths:** integrate the preexisting runtime config into HTTP base, auth-exempt paths, and metrics API creation, preserving one refresh/replay for ordinary requests and no credential mutation replay. This closes the frontend integration failure without completing the separate A3 SSE/status/backend work.
9. **OCR frontend boundary:** move Runsheets navigation into the admin group and guard its route; normalize path casing consistently with router matching. Remove the user-positive OCR path from the guarded user UI test inventory. The backend endpoint remains a separate open authorization gap.

## Browser coverage

| Screen | States/actions verified | Screenshots |
| --- | --- | --- |
| Login | Invalid credentials alert; valid synthetic user login | `21-login-*` |
| Dashboard | Admin/user layouts, rule search/clear, create editor, existing accept_all rule Preview with real memory controller, explicit above-target copy | `01-dashboard-*`, `22-rule-*` |
| History | Desktop table, mobile cards, page 1 to 2 | `02-history-*` |
| Notifications | Message preview and local test send success | `03-notifications-*` |
| LINE Bot | Group selection, local send and input clear; status-read error | `04-line-bot-*`, `18-line-status-error` |
| LINE Runsheets | Desktop table, mobile internal horizontal scrolling; primary query failure | `05-runsheets-*`, `17-runsheets-error` |
| Reports | Chart layout; three CSV requests triggered from UI | `06-reports-*` |
| Auto Accept History | Success/failed/indeterminate display; team 1, booking 20001, confirmation and local accept_all submit => acceptedCount 2; query failure | `07-auto-accept-*`, `16-auto-accept-error` |
| Audit | Desktop/table and mobile/cards; Enter on ID sort button => ascending; query failure | `08-audit-*`, `15-audit-error` |
| Teams | Local pause/resume; edit/save team name | `09-teams-*`, `19-team-edit-mobile` |
| Users | Local user creation and self-role/delete restrictions; team lookup failure disables dependent controls; Retry preserves draft | `10-users-*`, `23-users-*` |
| Settings API | Desktop and mobile save; initial load error removes editable form/save controls; Retry reloads saved values | `11-settings-*`, `14-settings-*` |
| Settings Notifications | Invalid numeric value rejected; reset restores draft | `12-settings-*` |
| Settings LINE | Group selection and local save | `13-settings-*` |

Screenshots live under `output/verification/2026-09-11-frontend-regression/`. Images were captured from the browser, written without image manipulation, and reopened for visual inspection. `browser-evidence.json` records actual viewport dimensions and page widths. Duplicate capture names reflect overwritten captures; use the last record for each name. Some images show scrolled content rather than the top of the page; `07-auto-accept-local-submit.jpg` shows the lower history cards, so submit success is supported by DOM observation and request evidence, not that image alone.

Main coverage uses 1440×1000 and 390×844. Login desktop's actual viewport was 1440×764. Added representative 320×740 Dashboard/editor/Preview and 768×1024 navigation checks. Main content remained within its viewport after the 320 px fix; Runsheets intentionally has an internally scrollable table. This does not establish complete coverage of every intermediate breakpoint, zoom level, virtual keyboard or real mobile safe-area.

Keyboard checks: mobile drawer open/close, initial link focus, Escape restoration; Quick Search focus trapping, Shift+Tab staying inside, Enter navigation, Escape restoring the named trigger after close animation; keyboard table sorting.

Role checks with `fixture-user`: `/LINE-IMAGE-EXTRACTIONS`, `/users`, `/teams`, `/audit`, `/settings/api` all redirected to `/` with no admin navigation links. Saved in `role-guard-evidence.json`. The API's actual authorization cannot be inferred from a frontend redirect.

## Automated evidence

| Check | Result |
| --- | --- |
| Frontend node baseline | 13 files: 11 pass, 2 fail (OCR source assertion and missing configured API integration) |
| Final frontend node suite | **16 files pass, 0 fail, 0 skipped** (`tests-final.log`) |
| Frontend TypeScript after final portal/wrapping changes | **exit 0** (`typecheck-frontend-final.log`, empty stdout is expected) |
| Frontend ESLint | **65 files, 0 errors, 0 warnings** (`lint-final.json`) |
| Scoped `git diff --check` | exit 0; only normal CRLF normalization notices |

New behavioral tests: `tests/frontend-provider-auth-feedback.test.ts`, `tests/frontend-configured-api-auth.test.ts`, `tests/frontend-settings-read-state.test.ts`. The existing settings-validation test was also run successfully by the settings reviewer. Full frontend node invocation selected `frontend-*.test.ts` excluding the two tests that directly launch a browser; these exclusions are explicit, not counted as passing or skipped node tests.

Not run: `frontend-provider-auth-browser.test.ts`, `frontend-team-provider-auth-settings.test.ts`, guarded `admin-ui-e2e.test.ts` / `user-ui-e2e.test.ts`, live MySQL/SPX scripts, production build/deploy. The prior rule-activation full-project typecheck recorded 68 backend A3 diagnostics unchanged from its baseline (`output/verification/2026-09-11-rule-activation/typecheck-comparison.json`). This pass does not claim a clean whole-project typecheck/build and did not rerun that unrelated backend gate.

Fixture smoke: 16 primary endpoints and 30 stateful synthetic API assertions passed during harness creation. Browser actions are separate evidence from those API checks. Archived pre-restart counters show LINE send 1, team runtime actions 2 and CSV requests 3. Latest run shows notification test 1, manual accept 1 and settings saves 3. Both runs record no unknown endpoints or external network attempts. Do not sum the two overlapping pre-restart snapshots. CSV response headers were smoke checked; downloaded file contents were not manually opened.

## Remaining scope and follow-ups

- **Backend OCR authorization:** `src/services/http-server.ts` still registers `lineImageExtractionsController` inside `userScope` near line 527. The desired admin-only policy is documented in the A3 rollout design. Move/enforce this boundary with backend authorization tests before calling OCR access restriction complete.
- **Cross-browser and real integration:** exercise Safari/iOS/Android, real virtual keyboard and safe-area behavior, provider challenge/session renewal, delivery and production API behavior in an appropriate integration environment. All credentials and messages in this run were synthetic; no real account login or external sending occurred.
- **Additional error interaction coverage:** cached background failures and dependent filter/group retries are not all browser exercised. Explicit error views, Settings retry and Users team retry were exercised; reducer/auth logic has node coverage.
- **UX refinements:** mobile login puts introductory content before the form, Runsheets remains a wide table, and manual accept displays JSON. Several remaining icon-only filter buttons outside History can use accessible names in a subsequent accessibility pass. These are separate from the corrected blocking regressions.
- **A3 implementation:** configured HTTP/metrics integration is complete for these tests; SSE/status/fallback wiring and existing backend compile failures remain part of the earlier workstream.

No branch, commit, push, merge, deployment, migration, live-secret access or production booking action was performed. Existing dirty/untracked work was preserved. This task's changes are intentionally left in the workspace for review.
