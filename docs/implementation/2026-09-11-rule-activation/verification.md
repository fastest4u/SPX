# Rule review implementation evidence — 2026-09-11

The approved first audit batch is implemented locally. Whole-booking acceptance may exceed the remaining target, as explicitly chosen by the user. The acceptance runtime and polling cadence are unchanged; this work improves intent accuracy and makes activation review mandatory at the HTTP boundary. No speed benchmark or whole-application responsive certification is claimed.

## Automated verification

- Frontend `npm run typecheck:frontend`: exit 0 after final source changes.
- Strict scoped backend TypeScript: exit 0 with `--target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --strict --types node,@fastify/jwt`, checking controller, review service and notify-rules.
- Actual Fastify/memory persistence suite: 22 passed, 0 failed across `rules-activation-review.test.ts`, `rules-controller-admin-scope.test.ts`, `notify-rules-matching.test.ts`. Root reran these from `output/verification/2026-09-11-rule-activation/cwd`, with synthetic test environment and no `.env` there. Includes expiry, tampering, permissions, stale snapshots, atomic competing writes, completed/disabled saves, and whole-booking mode truth.
- Frontend regression command: `node node_modules/tsx/dist/cli.mjs --test tests/frontend-rule-review.test.ts tests/frontend-rules-datatable.test.ts tests/frontend-dashboard-team-control.test.ts tests/frontend-provider-auth.test.ts`: 4 files passed, 0 failures. The new test verifies actual API request payloads and pure form/review/pause decisions. Browser interaction evidence below supplements these tests.
- Scoped ESLint on the six rule/vehicle components plus rule-review helper: exit 0, no warnings after cleanup.
- Full `npm run typecheck`: exit 2. Its 68 diagnostics are the same diagnostic lines as the prior audit baseline; `typecheck-comparison.json` records before=68, after=68, unchanged=true. They belong to existing incomplete A3/Gate6/realtime work. No successful production build is claimed.
- Premium strict audit of the exact component/API/type/helper source copies: no findings. The wider scoped audit including the existing dashboard file reports one scanner false positive at `routes/index.tsx:449`: existing `<Button asChild><a href={sessionRecovery.href}>` is rendered by the shared Slot owner as a real link. It is not an actionless literal button. The scanner treats component tags case-insensitively. No source workaround was introduced. Source copies and SHA-256 mapping are recorded beside both JSON reports.

## Browser verification

Used Codex in-app browser against an isolated Vite harness at `http://127.0.0.1:4178/`. Current source renders; rules CRUD/preview run through actual Fastify controller and a memory database. Other dashboard APIs use synthetic fixtures. No poller, provider login, LINE operation or live MySQL connection runs. Scenario controls are harness-only. The fixture must not be deployed.

| Width × height | State observed | Result |
|---|---|---|
| 390 × 844 | New disabled form, active normal review, acknowledgement and save | Page width 390; dialog x=16, width=358, height=812; no dialog horizontal overflow; save succeeds and focus returns to Add |
| 320 × 568 | Ordinary user editing existing whole-booking rule, target 1, then changed to 2 | Page width 320; dialog x=16, width=288, height=536; whole-booking warning visible, confirmation reachable by scroll |
| 768 × 1024 | Admin create with native team select and whole-booking checkbox | Two-column route fields, complete form/actions fit; selected team retained through preview and save |
| 1440 × 900 | Active edit with expired review | Page width 1440; dialog x=400, width=640, height=868; expired receipt blocks activation and offers fresh preview |
| 844 × 390 | Whole-booking confirmation after retry | Page width 844; dialog x=102, width=640, height=358; submit y=305 and height=44; save succeeds |
| 1294 × 856 | Before/after new-rule form and standalone preview | Matched baseline viewport; preserved existing dark/gold primitives, no clipping; preview shows correct mode and restores its opener focus |

Additional exercised cases:

- Empty name shows associated inline validation and first-invalid focus. New rule saves disabled without a preview.
- Wildcard and whole-booking acknowledgements independently block activation. Changing target after review clears both acknowledgements and requires a fresh preview. A team user preserves administrator-set whole-booking mode.
- Real stale-progress scenario: open a rule at need=2, update the memory-backed API to need=0 while form remains open, then pause through the UI. Persisted result remains need=0, fulfilled=true, enabled=false. UI sends only deliberately changed pause fields; the name remains required by the existing API schema.
- Escape originally dismissed the editor while the vehicle menu was open. Reproduced, fixed using the Dialog capture callback, then verified: first Escape closes the menu and focuses its trigger, second Escape closes a pristine editor. Dirty dismissal uses the app-owned discard view.
- Injected preview failure keeps recovery controls available and focuses the inline alert. Fresh retry restores the review. Injected expired UI metadata blocks the button; genuine signed-token expiry is covered separately by backend tests.
- Injected save failure retains input and acknowledgements and explains that the result is unconfirmed. Subsequent delayed save succeeds. While pending, submit/back are disabled and closing explains that a sent save cannot be cancelled.
- Delayed preview and delayed save were both closed before completion, followed by opening a new blank editor. After the delayed response, the new editor remains open and blank; old values do not appear. A successful old save still refreshes the list.
- Static canvas loads all seven referenced image elements and its keyboard-operable zoom updates from 100% to 60%. Temporary viewport overrides were reset. Local app and updated canvas remain available for inspection.

## Review and artifacts

Independent code review found the Escape capture ordering issue and retained stale-progress pause limitation. Both were fixed and verified as above; no gate bypass was found. This session does not alter unrelated pre-existing changes or automatically commit/deploy.

Artifacts are under `output/verification/2026-09-11-rule-activation/`: real browser JPEGs, `canvas.html`, `request-evidence-before-restart.json`, `request-evidence-final.json`, compiler baseline comparison, strict audit JSON and exact source hashes. Request evidence records review presence/acknowledgements, not review tokens. The canvas includes ordered steps and before/after images.

Remaining project work: other audit findings and responsive checks for untouched pages; resolve existing A3 compiler diagnostics before a production build/deployment. Production schema/transport/credentials were not changed in this batch.
