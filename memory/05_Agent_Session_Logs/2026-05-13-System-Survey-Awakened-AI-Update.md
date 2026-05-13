---
title: "2026-05-13 - System Survey Awakened AI Update"
type: session-log
session-date: 2026-05-13
agent: codex
duration-minutes: 90
outcomes:
  - Added source-grounded Awakened AI and SPX system map memory.
  - Added internal HTTP, SSE, poller, and dual-storage docs.
  - Corrected stale repo/memory rules and aligned migration SQL with schema.
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/system-map
---

# 2026-05-13 - System Survey Awakened AI Update

> [!abstract] TL;DR
> Performed a source-grounded survey of the SPX runtime and upgraded the Awakened AI memory layer with a whole-system map, API/SSE docs, and reusable component notes. Also fixed stale project instructions and migration SQL so fresh setup matches the current DB schema.

## Goal

Survey the SPX system in detail, update the "Awakened AI" memory system, and correct any source-of-truth drift found during the review.

## What Was Done

- [x] Read current runtime, config, poller, API client, HTTP server, settings, DB, notification, SSE, route, frontend API, and frontend SSE code.
- [x] Added [[Awakened-AI-System]] as the operating model for memory-aware AI work.
- [x] Added [[SPX-System-Map]] as a source-grounded runtime/data/UI map.
- [x] Added [[API-Internal-HTTP]] and [[API-SSE-Events]].
- [x] Added [[Component-Poller-Orchestration]] and [[Component-Dual-Storage-Notify-Rules]].
- [x] Updated [[MOC-Home]], [[Goals]], [[AGENT-IDENTITY]], [[SPX-Project-Rules]], API/component indexes, and [[AGENTS]] retrieval protocol.
- [x] Updated root `AGENTS.md` to match current build/dev/settings behavior.
- [x] Fixed `src/db/migration-sql.ts`, `src/scripts/generate-migration.ts`, and generated `migrations/001_create_booking_requests.sql` so fresh MySQL setup includes current columns and dashboard tables.

## Files Touched

- `AGENTS.md` - corrected build/dev commands, notification env vars, DB-backed live settings, and boot sequence.
- `src/db/migration-sql.ts` - added missing booking history columns and `metrics_snapshots` migration SQL.
- `src/scripts/generate-migration.ts` - included metrics snapshot SQL in generated migration file.
- `migrations/001_create_booking_requests.sql` - regenerated fresh setup schema from migration source.
- `memory/00_Index/Awakened-AI-System.md` - new Awakened AI operating model.
- `memory/01_Project_Rules/SPX-System-Map.md` - new detailed system map.
- `memory/02_API_Docs/API-Internal-HTTP.md` - new internal route reference.
- `memory/02_API_Docs/API-SSE-Events.md` - new SSE reference.
- `memory/03_Reusable_Components/Component-Poller-Orchestration.md` - new poller pattern reference.
- `memory/03_Reusable_Components/Component-Dual-Storage-Notify-Rules.md` - new dual-storage rules pattern.
- `memory/00_Index/MOC-Home.md`, `memory/00_Index/Goals.md`, `memory/AGENT-IDENTITY.md`, `memory/AGENTS.md`, `memory/01_Project_Rules/SPX-Project-Rules.md`, `memory/02_API_Docs/README.md`, `memory/03_Reusable_Components/README.md` - refreshed navigation and retrieval.

## Decisions Made

- Treat current `src/` behavior as higher priority than stale memory text when they disagree.
- Document DB-backed live settings as current truth: `SettingsController` uses `app_settings` and `reloadSettingsLive()`, not `.env` rewrite plus process exit.
- Include `metrics_snapshots` in generated baseline migration because it is part of `src/db/schema.ts`, memory DB, and runtime metrics persistence.

## Insights / Learnings

- The Memory Vault was structurally healthy, but lacked a single source-grounded whole-system map; [[SPX-System-Map]] now fills that retrieval gap.
- The previous project rules still described old settings behavior; future system surveys should compare root `AGENTS.md`, memory rules, and actual source side by side.
- Existing production migrations are filename-tracked. Updating an already-applied baseline SQL file improves fresh installs but does not alter an existing production DB by itself.

## Open Issues / Follow-ups

- [ ] Confirm production DB schema has all current `spx_booking_history` columns if there is evidence of insert failures.
- [ ] Test this vault with non-Codex agents (Claude Code / Cursor / Cascade) and record results.
- [ ] Add a dedicated auth/session API note if cookie/JWT behavior changes again.

## Quality Checks

> [!success] Verification
> - [x] `npm run memory:check` passed before session log creation.
> - [x] `npm run db:generate` passed, including full `npm run build`.
> - [x] Generated migration file reviewed for current tables.

## References

- [[Awakened-AI-System]]
- [[SPX-System-Map]]
- [[API-Internal-HTTP]]
- [[API-SSE-Events]]
- [[Component-Poller-Orchestration]]
- [[Component-Dual-Storage-Notify-Rules]]
