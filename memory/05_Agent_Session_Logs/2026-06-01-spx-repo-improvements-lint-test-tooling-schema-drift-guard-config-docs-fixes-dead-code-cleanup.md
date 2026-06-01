---
title: "2026-06-01 - SPX repo improvements: lint/test tooling, schema drift guard, config/docs fixes, dead-code cleanup"
type: session-log
session-date: 2026-06-01
agent: cascade
outcomes:
  - "Added ESLint flat config (bug-catcher posture) + Prettier per-area config + scripts; wired Lint->Build->Test gate into .github/workflows/deploy.yml"
  - "Added scripts/run-tests.mjs runner so the 8 orphaned tests/*.test.ts actually run; added 4 new tests (schema-consistency drift guard, error-classifier, notify-rules-matching, need-budget). npm test = 12/12 pass"
  - "Schema single-source: added tests/schema-consistency.test.ts asserting all 9 Drizzle tables have matching MySQL + SQLite runtime DDL (catches drift in CI) instead of refactoring load-bearing prod bootstrap"
  - "Unified BOOKING_DETAIL_CONCURRENCY default to 8 in src/config/env.ts (was 20, mismatched settings.ts)"
  - "Refreshed stale README: React 18->19, dev uses tsx not ts-node, removed hardcoded prod IP, documented 11 missing env vars"
  - "Fixed all 21 ESLint warnings (dead imports/vars removed, pause/resume typed as {paused:boolean}, db client any justified) and set lint to --max-warnings 0"
created: 2026-06-01
updated: 2026-06-01
tags:
  - session-log
  - project/spx
---
# 2026-06-01 - SPX repo improvements: lint/test tooling, schema drift guard, config/docs fixes, dead-code cleanup

## TL;DR
- Added ESLint flat config (bug-catcher posture) + Prettier per-area config + scripts; wired Lint->Build->Test gate into .github/workflows/deploy.yml
- Added scripts/run-tests.mjs runner so the 8 orphaned tests/*.test.ts actually run; added 4 new tests (schema-consistency drift guard, error-classifier, notify-rules-matching, need-budget). npm test = 12/12 pass
- Schema single-source: added tests/schema-consistency.test.ts asserting all 9 Drizzle tables have matching MySQL + SQLite runtime DDL (catches drift in CI) instead of refactoring load-bearing prod bootstrap
- Unified BOOKING_DETAIL_CONCURRENCY default to 8 in src/config/env.ts (was 20, mismatched settings.ts)
- Refreshed stale README: React 18->19, dev uses tsx not ts-node, removed hardcoded prod IP, documented 11 missing env vars
- Fixed all 21 ESLint warnings (dead imports/vars removed, pause/resume typed as {paused:boolean}, db client any justified) and set lint to --max-warnings 0

## Goal
SPX repo improvements: lint/test tooling, schema drift guard, config/docs fixes, dead-code cleanup

## What Was Done
- Added ESLint flat config (bug-catcher posture) + Prettier per-area config + scripts; wired Lint->Build->Test gate into .github/workflows/deploy.yml
- Added scripts/run-tests.mjs runner so the 8 orphaned tests/*.test.ts actually run; added 4 new tests (schema-consistency drift guard, error-classifier, notify-rules-matching, need-budget). npm test = 12/12 pass
- Schema single-source: added tests/schema-consistency.test.ts asserting all 9 Drizzle tables have matching MySQL + SQLite runtime DDL (catches drift in CI) instead of refactoring load-bearing prod bootstrap
- Unified BOOKING_DETAIL_CONCURRENCY default to 8 in src/config/env.ts (was 20, mismatched settings.ts)
- Refreshed stale README: React 18->19, dev uses tsx not ts-node, removed hardcoded prod IP, documented 11 missing env vars
- Fixed all 21 ESLint warnings (dead imports/vars removed, pause/resume typed as {paused:boolean}, db client any justified) and set lint to --max-warnings 0

## Files Touched
- eslint.config.mjs
- .prettierrc.json
- .prettierignore
- scripts/run-tests.mjs
- tests/error-classifier.test.ts
- tests/notify-rules-matching.test.ts
- tests/need-budget.test.ts
- tests/schema-consistency.test.ts
- .github/workflows/deploy.yml
- package.json
- README.md
- src/config/env.ts
- src/db/client.ts
- src/utils/logger.ts
- src/services/notifier.ts
- src/services/line-image-extraction.ts
- src/services/codex-device-auth.ts
- src/services/line-bot.ts
- src/frontend/lib/api.ts
- src/frontend/lib/settings-shared.tsx
- src/frontend/components/DataTable.tsx
- src/frontend/routes/index.tsx
- src/frontend/routes/line-bot.tsx
- src/frontend/routes/users.tsx
- scripts/mcp-memory-launcher.mjs
- scripts/memory-check.mjs

## Decisions Made
- Chose schema drift-DETECTION guard test over refactoring the load-bearing production DB bootstrap (lower risk, catches the real failure mode)
- Kept renderMobile in DataTableProps for backward compat (4 callers pass it) but removed the unused destructure
- Justified the intentional db/client.ts AnyDrizzleDb=any via eslint-disable (dual MySQL/SQLite driver typing) rather than forcing a type
- Did NOT commit/push/deploy per repo direct-to-main policy; user chose only to save the memory session log

## Open Follow-ups
- [ ] User to decide commit/push/deploy (deferred this session)
- [ ] 2 high-severity npm audit vulnerabilities introduced by new eslint/prettier toolchain - review with npm audit (did not run --force)
- [ ] Legacy root scratch files (test-api.js, test-api.ts, poll-bidding.js) are eslint-ignored; consider removing
- [ ] UserMobileCard/renderMobile is an abandoned mobile-card feature (removed unused parts) - revive or leave
- [ ] project-memory MCP vault path may point to a different project (api gateway) - verify/fix so SPX auto-memory works
- [ ] Schema still defined in 4 places (Drizzle, migrations, MySQL runtime DDL, SQLite DDL) - drift guard added but true single-source refactor remains open

## References
- AGENTS.md
- .github/workflows/deploy.yml
- eslint.config.mjs
- tests/schema-consistency.test.ts

## Verification
All green on Windows: npm run lint (0 errors/0 warnings, strict --max-warnings 0); npm run build (typecheck + esbuild + vite); npm test (12/12). Dashboard JS chunk shrank ~721kB->682kB after removing dead lineQuota fetch.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
