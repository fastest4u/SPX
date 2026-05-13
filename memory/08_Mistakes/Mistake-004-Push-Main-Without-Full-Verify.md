---
title: Mistake-004 - Push Main Without Full Verify
type: mistake
severity: high
status: open
occurred-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
agent: codex
area: area/deploy
confidence: high
aliases:
  - Mistake-004
  - M-004
  - Push without verify
tags:
  - mistake
  - project/spx
  - area/deploy
  - topic/verification
  - severity/high
---

# Mistake-004 - Push Main Without Full Verify

> [!abstract] One-liner
> SPX auto-deploys from `main`, so pushing without the full local gate can turn a local oversight into a production incident.

---

## What Can Happen

- Memory checks pass but application build fails.
- Application build passes but memory contains stale instructions.
- A schema-sensitive change is pushed before DB drift is checked.
- Production auto-deploys a commit that was not verified as one complete unit.

---

## Root Cause

The repo intentionally uses direct pushes to `main` for completed fixes. That keeps deployment fast, but it removes the branch/PR buffer where CI would normally catch mistakes.

---

## Correct Pattern

Before pushing to `main`:

```bash
npm run verify
```

If DB schema changed or production drift is suspected:

```bash
npm run schema:verify
```

Then stage only task-relevant files and push.

---

## How AI Should Avoid This

- Read [[Runbook-Deploy-Safety-Checklist]] before production-impacting pushes.
- Mention the verification result in the final response.
- If `npm run verify` cannot be run, say why before pushing.
- Do not treat docs-only changes as exempt when they affect Memory Vault behavior.

---

## Detection

Symptoms:

- Final answer says code was pushed but does not mention `npm run verify`.
- `git log -1` points to a commit that changed code or memory without a session log.
- Production deploy fails immediately after a push that skipped local verification.

---

## Related

- [[Runbook-Deploy-Safety-Checklist]]
- [[Memory-Quality-Score]]
- [[SPX-Project-Rules]]
