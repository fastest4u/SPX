# Rule activation review and responsive editing

User authorization: implement the first audit batch. On 2026-09-11 the user explicitly chose whole-booking acceptance even when its request count exceeds `need`, with clear UI disclosure. This supersedes the audit's suggested strict cap for `accept_all`.

## Scope and decisions

- Existing flow: create/edit/preview rules in the current dashboard. Preserve the dark/gold DESIGN.md tokens and shared primitives. This is a bounded extension of that flow, not a redesign of the whole application.
- Normal mode retains request-count behavior. In `accept_all`, `need` is the remaining target; accepting a booking can exceed it and include other requests in that booking. Do not modify the acceptance runtime, counters, transport cadence or automatic renewal in this batch.
- New rules begin disabled. Active create/edit requires reviewing current conditions and explicit acknowledgement of wildcard dimensions and whole-booking mode when applicable. Disabled/completed saves and disabling remain available without review.
- Preview is historical, bounded and read-only. Its sample cannot establish live availability, exact whole-booking size, or a guaranteed outcome. Display scanned/matched counts as history, with clear Thai copy and mode semantics.
- Server-issued signed review expires after five minutes and binds actor, resolved team, create/edit identity and effective fields. Editing fields invalidates browser review immediately. Changed server state requires a fresh review. Review metadata is transient and never persisted in rule records.
- Preserve server-owned team/admin permissions. An ordinary user cannot select `accept_all`, but must see and acknowledge it when editing a rule that an administrator already configured with it.
- Reuse one editor and review summary for create/edit and the existing standalone preview. Keep values on failure, inline validation/error recovery, duplicate guards, late-response guards, confirmation before discarding edits, focus management and bounded dialog scrolling.
- Verify the changed flow at mobile 390×844 and 320×568, tablet 768×1024, desktop 1440×900 and short landscape. This does not certify every existing application page as fully responsive.

## Wire contract

`POST /api/rules/preview` accepts `{rule, ruleId?, limit?, sampleLimit?}`. It returns the existing preview fields plus `review: {token, expiresAt, wildcardFields, acceptAll}`. `wildcardFields` contains zero or more `origins`, `destinations`, `vehicle_types`.

Create/update accepts `activationReview?: {token, acknowledgeWildcard?, acknowledgeAcceptAll?}`. Effective active writes need an unexpired matching token and the applicable acknowledgements. Missing, changed or expired review returns a recoverable 409. Tokens do not replace authorization. Backend derives completed flags consistently from `need` so flags cannot bypass activation review.

## Execution ledger

- [x] Backend: failing route tests, signed review, permission-normalized preview, active-write gate, stale-edit guard; preserve runtime semantics.
- [x] Frontend: failing API contract tests, shared editor/review summary, explicit mode/target labels, transient review and race guards.
- [x] Responsive and interaction checks: narrow/short layouts, options, keyboard, validation, preview, acknowledgements, failed/stale response, create/edit and disabled save.
- [x] Integration review, focused regressions, frontend typecheck, full typecheck comparison, scoped static/lint checks and final evidence in `verification.md`.

Root owns memory lifecycle `memory-1789135960115`. Backend implementer owns controller/review service and related tests; root owns frontend/contracts/verification. No commits, branches, migrations, live operations or deployment. Existing A3 compiler failures are tracked separately; do not erase or broadly repair unfinished work.
