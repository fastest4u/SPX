---
title: Runbook - Docs Drift Cleanup
type: runbook
status: active
last-verified: 2026-05-14
verified-by: opencode
source: file:README.md + file:.env.example + file:src/config/env.ts + project-memory MCP tools
confidence: high
severity-when-applies: medium
related-adrs:
  - [[ADR-002-DB-Backed-Live-Settings]]
created: 2026-05-14
updated: 2026-05-14
aliases:
  - Docs Drift Cleanup
  - Documentation Drift
  - Source Docs Reconciliation
tags:
  - runbook
  - project/spx
  - topic/docs
  - topic/memory-vault
  - area/config
---

# Runbook - Docs Drift Cleanup

> [!abstract] Use this when
> Use this when README, `.env.example`, root `AGENTS.md`, or Memory Vault notes conflict with executable source files.

## Safety Rules

- Trust executable source first: `package.json`, `tsconfig*.json`, `vite.config.ts`, `src/`, `migrations/`, CI workflows, Docker files.
- Do not read, print, copy, or commit real `.env` secret values while checking env docs.
- Treat old session logs as history, not current truth; update active docs and create a new session log instead.

## Common Drift Patterns

| Stale claim | Current source of truth |
|---|---|
| Legacy LINE Notify token name | `src/config/env.ts` uses `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`, `DISCORD_WEBHOOK_URL`, or `LINEJS_TEST_ENABLED=true`. |
| Settings rewrite `.env` and restart | `SettingsController` writes `app_settings`, preserves masked secrets, and calls `reloadSettingsLive()`. |
| No CI workflow | `.github/workflows/deploy.yml` builds on `main` then deploys by Docker Compose. |
| `npm run dev -- 10` uses ts-node | `package.json` runs backend with `tsx` and Vite concurrently; CLI interval seconds apply to `src/app.ts`/`dist/app.js`. |

## Procedure

1. Identify the claim and the files that repeat it.
2. Open the executable source that owns the behavior.
3. Update active docs: `README.md`, `.env.example`, root `AGENTS.md`, and relevant Memory Vault notes.
4. If a stale phrase could recur inside `memory/`, use `memory_checkStaleness`, `memory_verifySourceTruth`, and targeted `memory_search` queries to catch it.
5. Update `updated:` and truth fields on edited Memory Vault notes.
6. Add or update a mistake note when the drift caused a wrong answer or bad operational path.
7. Write a session log for the cleanup.

## Verification

Run after Memory Vault changes:

Use project-memory MCP verification:

- `memory_verifyVault`
- `memory_verifyNote` for edited notes
- `memory_verifySourceTruth` for source-backed claims
- `memory_findBrokenLinks` if links changed

Run after script or app-code changes too:

```bash
npm run verify
```

For env docs, manually check that examples name variables from `src/config/env.ts` and do not include secret values.

## References

- [[Source-Grounded-Documentation]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
- [[Secret-Safe-Operational-Patterns]]
- [[SPX-Project-Rules]]
