---
title: Runbook - Deploy Safety Checklist
type: runbook
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:AGENTS.md + file:package.json + file:memory/08_Mistakes
confidence: high
severity-when-applies: critical
related-adrs:
  - [[ADR-001-Dual-Storage-Notify-Rules]]
  - [[ADR-002-DB-Backed-Live-Settings]]
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Deploy Safety Checklist
  - Pre-Push Checklist
  - Main Deploy Checklist
tags:
  - runbook
  - project/spx
  - area/deploy
  - topic/production
  - topic/verification
---

# Runbook - Deploy Safety Checklist

> [!abstract] Use this before pushing to `main`
> SPX production auto-deploys from `main`. Treat every push as a production deployment unless the user explicitly says otherwise.

---

## Required Pre-Push Gate

Run from repo root:

```bash
npm run verify
```

Required result:

- `memory_verifyVault` returns `ok=true` with no errors.
- Targeted project-memory MCP validators pass for edited notes or source-backed claims.
- `memory_lifecycleStatus` shows the session lifecycle was recorded.
- `build` passes.

If DB schema changed or production drift is suspected, also run:

```bash
npm run schema:verify
```

`schema:verify` is read-only, but it requires DB credentials and a reachable MySQL server.

---

## Git Staging Safety

Before commit:

```bash
git status --short
```

Confirm:

- No `.env` file is staged.
- No secret-bearing output is staged.
- No generated `dist/`, `data/`, `logs/`, `node_modules/`, or `notify-rules.json` files are staged.
- No local Obsidian state such as `memory/.obsidian/graph.json` is staged unless the user explicitly asked for Obsidian config changes.
- Only task-relevant files are staged.

Use explicit path staging:

```bash
git add -- <file-1> <file-2>
```

Avoid broad staging when local editor state is dirty.

---

## Production Impact Check

Before pushing, state the impact:

- App code only.
- Memory/docs only.
- DB schema or migration behavior.
- Runtime env/settings behavior.
- Notification or auto-accept behavior.
- Frontend/dashboard behavior.

If impact includes DB, auth, auto-accept, or deploy scripts, check the related runbook before push.

---

## Push

```bash
git push origin main
```

Then verify:

```bash
git log -1 --oneline
```

For production deploy failure, use [[Runbook-Production-Deploy]].

---

## Common Failure Modes

| Failure mode | Prevention |
|---|---|
| Push to `main` without `npm run verify` | Follow [[Mistake-004-Push-Main-Without-Full-Verify]]. |
| Local Obsidian state staged accidentally | Follow [[Mistake-005-Local-Obsidian-State-Staged]]. |
| Baseline migration edited but production already migrated | Follow [[Mistake-003-Baseline-Migration-Drift]] and [[Runbook-Production-Schema-Verification]]. |
| Memory docs contradict source code | Follow [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]. |

---

## Related

- [[Runbook-Production-Deploy]]
- [[Runbook-Production-Schema-Verification]]
- [[Memory-Quality-Score]]
- [[SPX-Project-Rules]]
