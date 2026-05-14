---
title: "2026-05-13 - Production Schema Verify"
type: session-log
session-date: 2026-05-13
agent: codex
duration-minutes: 20
outcomes:
  - Fixed schema verification row parsing for MySQL information_schema output.
  - Ran read-only schema verification on production.
  - Confirmed production schema matches the source contract.
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - area/db
  - topic/production
  - topic/verification
thread: verification
related-sessions:
  - "[[2026-05-13-Memory-Debt-And-Alert-Policy]]"
---

# 2026-05-13 - Production Schema Verify

> [!abstract] TL;DR
> Production ran `npm run schema:verify` successfully after fixing MySQL row alias handling. The check observed all 9 expected tables and reported that schema matches the source contract.

## Goal

Verify the production MySQL schema against the current SPX source contract without exposing DB secrets.

## What Was Done

- [x] SSHed to production and ran `npm run schema:verify`.
- [x] Found a script bug where MySQL returned `information_schema` columns with names that the script did not normalize.
- [x] Fixed `scripts/schema-verify.mjs` by aliasing selected `information_schema` fields to lowercase keys.
- [x] Pushed commit `3fe0661`.
- [x] Re-ran `npm run schema:verify` on production from commit `3fe0661`.
- [x] Updated [[Goals]] to record production schema verification.

## Production Result

Observed expected tables: 9 of 9.

| Table | Columns | Indexes |
|---|---:|---:|
| `app_settings` | 4 | 1 |
| `audit_logs` | 5 | 1 |
| `auto_accept_history` | 12 | 3 |
| `line_bot_sessions` | 6 | 2 |
| `metrics_snapshots` | 14 | 2 |
| `notify_rules` | 12 | 1 |
| `schema_migrations` | 3 | 2 |
| `spx_booking_history` | 16 | 4 |
| `users` | 5 | 2 |

Result: schema matches the source contract.

## Files Touched

- `scripts/schema-verify.mjs` - aliased MySQL `information_schema` selected fields so result rows parse consistently.
- `memory/00_Index/Goals.md` - recorded production schema verification.
- `memory/05_Agent_Session_Logs/2026-05-13-Production-Schema-Verify.md` - this log.

## Decisions Made

- Do not print DB name, password, host, or `.env` values in logs or final output.
- Keep `schema:verify` read-only and separate from `npm run verify` because it needs production DB access.

## Insights / Learnings

> [!tip] Worth promoting to `07_Insights/`?
> Schema verification scripts should alias `information_schema` columns explicitly; relying on driver casing can create false drift reports.

## Open Issues / Follow-ups

None for this verification pass.

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All edited notes have updated `updated:` field
> - [x] Wikilinks added to related notes
> - [x] Tagged with >= 2 tags from taxonomy
> - [x] No file with > 1 unrelated H2
> - [x] Session log written (this file)
> - [x] `node --check scripts/schema-verify.mjs` passed
> - [x] `npm run memory:verify` passed before production re-run
> - [x] Production `npm run schema:verify` passed

## References

- Commits: `3fe0661`
- Related runbook: [[Runbook-Production-Schema-Verification]]
- Related mistake: [[Mistake-003-Baseline-Migration-Drift]]
