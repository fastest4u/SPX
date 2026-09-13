# UX Contract

This contract covers provider account management and the rule create/edit/review flow. Existing unrelated screens are not claimed to have passed this contract's verification.

## Product context

Thai operators connect the provider account used by their team; administrators can manage a selected team. Keep current dashboard navigation and operational controls. Aim for WCAG 2.2 AA, using semantic fields/actions, keyboard-operable dialogs, and text status. Format provider timestamps for the Thai interface with an explicit timezone in detailed status when needed; do not reinterpret stored UTC timestamps as local input.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Permissions, account/session lifecycle, run intent | `docs/superpowers/specs/2026-09-11-team-provider-auth-design.md` | Accepted feature specification | 2026-09-11 |
| Per-team stored credentials and encryption | `memory/04_Architecture_Decisions/store-myagencyservice-login-credentials-per-team-in-spx-with-encrypted-passwords.md` | Architecture decision | 2026-09-11 |
| Operational recovery and legacy transition | `docs/runbooks/team-provider-auth.md` | Feature runbook | 2026-09-11 |
| Billing, deletion, legal copy | Outside this feature | No new policy | 2026-09-11 |

## Visual contract

`DESIGN.md` records the current identity. Runtime ownership stays in `src/frontend/index.css`, its Tailwind theme adapter, and shared UI primitives. This workflow adds no theme or token scale. Compare against the dashboard own-team controls and Teams dialogs for density, focus, and feedback.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | Shared Input/Label/Button and `ProviderAuthPanel` | Feature spec and this contract | Connect/replace; own-team/admin-selected team | Browser validation, keyboard, request contract |
| Scrollbar | `src/frontend/index.css` | Runtime CSS and DESIGN.md | Bounded dialog geometry; normal page scroll | Narrow viewport and computed-style inspection |
| Toast | Global Sonner Toaster in `src/frontend/main.tsx` | Existing application provider | Success/error plus persistent inline guidance | Live feedback in browser fixture |
| CRUD | `providerAuthApi` and shared `ProviderAuthPanel` | Scoped backend API and feature spec | Read, connect/replace, reconnect; stay in current context | Synthetic success/failure/reconnect flow |
| Rule form | Shared Input/Label/Button and `RuleEditorDialog` | `docs/implementation/2026-09-11-rule-activation/design.md` | Create disabled by default; edit own-team/admin rules | Validation, unchanged-progress pause, browser requests |
| Select/Listbox | Native team select | Existing administrator team ownership choice | OS-owned team selection; no custom listbox semantics | Keyboard/native selection and mobile bounds |
| Date | Existing native Runsheet date/month filters | Operator addendum dated 2026-09-13 | OS-owned popup; Thai owned labels | Associated filters and five viewport profiles |
| Disclosure | `VehicleTypeMultiSelect` | Existing vehicle options | Authored multiple toggle buttons; Escape closes menu before dialog | Expanded/pressed semantics, outside click, keyboard |
| Rule review | `RuleReviewSummary` and shared Dialog | User whole-booking decision and signed API review contract | Standalone historical preview; active save acknowledgement | Historical counts, mode disclosure, scope warnings, expiry |

No table selection, date picker, or deletion capability is added by these features.

## Flow ledger

| Operation | Trigger | Pending | Success | Failure/recovery | Source |
|---|---|---|---|---|---|
| Read status | Open account panel | Bounded loading state | Show public metadata | Inline retry; no blank success panel | Feature spec |
| Connect/replace | Explicit form submission with email/password | Block duplicate submission and show busy state | Clear password, refresh status, Thai acknowledgement; stay in context | Retain editable email; explain safe error and retry timing; old saved account remains represented accurately | Feature spec |
| Reconnect | Explicit action using saved account | Same pending/duplicate guard | Refresh status and acknowledge | Display attention or cooldown guidance; no silent password retry | Feature spec |
| Close | Dismiss dialog | Clear local secret state even during pending work | Restore focus to trigger | A late completion cannot populate a closed or different-team form | Feature spec / shared Dialog |
| Create team | Existing team creation | Existing submit behavior | Existing Teams context, then account connection available | Existing team settings remain editable | Feature plan |
| Manual session override | Advanced/manual section | Existing team save | Existing flow; status revalidated | Actual session replacement follows backend invalidation rules | Feature spec |

## Forms and feedback

Use `noValidate` and app-owned Thai validation with field associations, `aria-invalid`, and first-invalid focus. Email and password are separate labeled inputs. The password begins blank, stays masked by default, supports paste/password managers, and has an accessible visibility control. A blank password never silently replaces the stored one. Show saved-password presence through metadata only.

Use the existing Dialog focus trap, Escape, description, overlay, and focus restoration. Localize owned close controls. Keep the complete form and actions reachable on narrow/short screens. Do not add a confirmation for routine connection; the submit action is explicit. Inline errors persist until correction or another attempt, while global Sonner provides supplementary acknowledgement.

## Async and permissions

Credential submissions are pessimistic and are not automatically replayed by the browser client. Duplicate actions remain disabled while pending, and cooldown shows when retry is possible. Passwords never enter query keys, persistent browser storage, logs, analytics, or displayed raw errors. Clear form and temporary request state on success/dismissal; account switches must not show another team's late response.

Own-team UI uses the authenticated-user route, while the administrator variant supplies the selected team only through its scoped URL. The server owns authorization. Provider login failures remain provider errors, distinct from an expired SPX dashboard login. Reconnecting does not change the visible team's running intent; existing operational controls own that action.

## Verification

Required evidence is the focused frontend provider-auth test and isolated browser fixture using synthetic credentials, plus the existing frontend team control/action regressions and frontend TypeScript check. Cover loading, missing account, success, failed replacement, reconnect, cooldown, keyboard validation, dismissal, and a narrow viewport with reduced motion. Visually inspect desktop/mobile screenshots. Run the premium static audit against the declared feature scope and search changed code for native dialogs, non-semantic actions, and secret retention. Static success alone is not runtime or accessibility certification.

Record exact commands/results and any pre-existing unrelated audit or typecheck failures in the task report; do not expand this feature into an unrelated application-wide migration.

## Rule activation flow — 2026-09-11

The user's explicit decision permits accepting a whole booking beyond the remaining truck target. Normal request selection remains bounded by the remaining count. Display this distinction in the editor, summary, and list for both roles. A historical match count is not a promise of available jobs or the full booking size.

New rules begin disabled. Before an active create/edit, the operator reviews current inputs and acknowledges each applicable wildcard and whole-booking warning. Every input change invalidates the prior review. The server owns permissions, signs an actor/team/intent/snapshot-bound five-minute receipt, and rejects stale writes. An ordinary team user preserves and acknowledges an existing administrator-selected whole-booking mode. Disabled saves remain possible without preview; send only deliberately changed values on pause so an unchanged old target cannot restore accepted progress.

| Operation | Trigger | Pending | Success | Failure/recovery | Source |
|---|---|---|---|---|---|
| Preview | Review action on current valid form | Disable duplicate actions, retain values | Current historical sample and explicit scope | Inline retry; discard late responses after dismissal/input change | Rule activation design |
| Active save | Valid receipt and applicable acknowledgements | Submit once; show saving | Refresh list, toast, restore opener focus | Keep form; stale receipt requests fresh preview; ambiguous transport error asks to check list before retry | Rule activation design |
| Paused save | Disabled form submission | Same save guard | Rule remains disabled; unchanged progress preserved | Keep entered values and inline recovery | Rule activation design |
| Edit after review | Back to form | Invalidate receipt immediately | Re-review current fields before activation | Previous acknowledgements never carry to new scope | Rule activation design |
| Dismiss | Cancel, Escape, close | Abort pending preview; save cannot be cancelled by closing | App-owned discard view for dirty input, then restore focus | No late response populates a reopened/different-user editor | Rule activation design |

Use bounded vertical scrolling, 16px viewport margins, and no horizontal overflow for changed dialogs. Verify 320×568, 390×844, 768×1024, 1440×900 and short landscape. Shared close targets are 44px. These checks cover these flows, not every application screen. Static audit uses exact scoped source copies because its sourceRoots setting only accepts directories; source hashes are recorded with the evidence.

## Operator history, Runsheets and login — 2026-09-13

This bounded addendum follows the source-owned permission contracts in `auto-accept-history-controller.ts`, `bidding-controller.ts` and `routes/__root.tsx`. It preserves the Quiet Authority tokens and shared layout; it does not claim a theme redesign or a new recovery service.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| History navigation and permissions | `AppLayout`, backend history team scope, root route guard | Existing own-team history and admin-only manual/OCR permissions | Common history entry; selected-team manual acceptance for admin | Real memory HTTP status filters and Admin/User E2E |
| Manual acceptance feedback | `ManualAcceptResult` and history page mutation owner | Controller observed new accepted request IDs | Submitted, verified subset, unproven, unsuccessful/unknown transport | Panel regression, mocked controller, deferred browser response |
| Responsive records | `MobileRecordCard`, `DataTable`, `PaginationControls` | Persisted Runsheet record | Cards below md, bounded table above md | Five viewport profiles, all record fields and named image action |
| Form validation | Shared Input/Button and login field owner | Existing dashboard authentication | Associated Thai required errors, first-invalid focus, password manager/paste/autocomplete | Login validation, toggle, async error and successful real local login |
| Select/Listbox | Native team/status and Runsheet sorting selects | Existing platform-owned selectors and DataTable sort state | OS popup geometry accepted | Keyboard selection, query ordering, page reset and viewport bounds |
| Date | Existing native Runsheet date/month filters | Stored document and saved timestamps | OS-owned picker locale/geometry accepted; owned labels are Thai | Associated labels and responsive layout; real-device picker checks remain a limit |
| Search | Existing debounced query hook and screen state | Existing transient list search architecture | Local transient query/filter/page state retained; clear refreshes immediately and restores focus | Search, no-results, clear and filter browser checks |

Manual history records `success`/`verified_success` only for the observed new request IDs. A nonempty subset establishes only that subset, not completion of the whole booking. No observed new IDs yields `indeterminate`, zero confirmed acceptances and no verified timestamp. The compatible response's legacy `acceptedCount` may still carry the provider's reported count; only the additive verified count and observed IDs support confirmation copy. An HTTP/network failure does not establish business rejection. The operator is directed to check the provider before another submission; the UI promises no automatic follow-up and does not retry the mutation.

Booking/team edits clear the prior result and confirmation synchronously. Each attempt is bound to its submitted booking/team and generation; a late result after editing cannot populate the current form. Editing never cancels or repeats the provider mutation. Team loading/error guards and explicit confirmation remain required. History refresh follows settled requests, including ambiguous failures.

Runsheet cards retain trip, route, driver, vehicle, agency, document date, saved timestamp and an accessible image action. Search/clear/filter controls have Thai names and expanded/panel relationships; filter labels activate their inputs. Login is first in narrow DOM/visual order while desktop keeps its two-column arrangement; required messages are field-specific, associated and focused, and the password toggle has a 44px target and visible keyboard focus.

Executable verification is owned by `tests/operator-ui-e2e.ts` and the focused dashboard/manual-outcome tests. Admin/User suites require explicit `npm run test:e2e`; their default whole-suite skip is not browser evidence. The isolated E2E runner builds current production-mode frontend source, uses synthetic allowlisted child env and memory DB, blocks Service Workers/non-loopback browser traffic, records expected font attempts, captures actual HTTP error statuses, fences provider/LINE actions, and bounds child execution.

Runsheet sorting remains available in both card and table layouts. Native mobile selectors reuse the table column keys and direction state; changing either returns to page 1. Browser-owned popup geometry is intentional, matching existing native selectors. Keyboard selection, actual server ordering, pagination reset and desktop/mobile state continuity are covered by the operator E2E.

Dashboard Live requires an enabled, running worker with a recent successful poll for the signed-in team and healthy provider session. Fresh SSE observations expire after 120 seconds into bounded HTTP refresh. Events outside the actor metrics scope cannot replace or renew its retained observation; administrator metrics retain the aggregate while individual team events arrive. Optional A3 stage/pool data may be absent on legacy servers and remains explicitly unknown.
