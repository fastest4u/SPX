---
title: Mistake-002 - Stale Memory Docs Overrode Source
type: mistake
severity: medium
status: resolved
occurred-date: 2026-05-13
resolved-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
agent: codex
area: topic/memory-vault
confidence: high
aliases:
  - Mistake-002
  - M-002
  - Stale memory docs
tags:
  - mistake
  - project/spx
  - topic/memory-vault
  - severity/medium
---

# Mistake-002 - Stale Memory Docs Overrode Source

> [!abstract] One-liner
> Memory notes and root instructions still described old settings and command behavior after the source code had moved to DB-backed live settings and a different dev/build flow.

---

## What Happened

During the source survey, current code showed:

- `SettingsController` writes selected settings to `app_settings`.
- `reloadSettingsLive()` applies settings without process restart.
- `npm run build` includes backend/frontend typechecks, esbuild, and Vite.
- `npm run dev` runs backend and Vite concurrently.

Older project instructions still described previous behavior. If trusted blindly, an AI could recommend wrong operational steps.

---

## Root Cause

Memory was updated earlier than the latest implementation and did not have an automated stale-claim detector. The vault had structural checks but not semantic checks for known dangerous stale claims.

---

## Correct Pattern

Before updating memory or answering operational questions:

```text
source files -> root AGENTS.md -> verified memory notes -> old session logs
```

If source and memory disagree, update memory or record a follow-up before relying on it.

---

## Time Lost

About 20 minutes of extra source verification and memory correction.

---

## How AI Should Avoid This

> [!tip] Pre-flight checklist
> 1. For behavior claims, inspect `src/` first.
> 2. Run `memory_verifyVault`.
> 3. Run `memory_verifySourceTruth` and `memory_checkStaleness` after changing core memory.
> 4. Add or update source-grounded notes when a drift pattern is found.

---

## How To Detect Recurrence

Symptoms:

- Active docs mention old env vars or old commands.
- Memory says a feature restarts the process, but source applies live.
- MCP retrieval or verification misses a critical behavior.
- A new AI cites session logs instead of current source-grounded notes.

---

## Related

- [[Awakened-AI-System]]
- [[Memory-Evaluation-Test]]
- [[SPX-System-Map]]
- [[2026-05-13-System-Survey-Awakened-AI-Update]]
