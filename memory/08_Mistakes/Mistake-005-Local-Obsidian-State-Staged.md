---
title: Mistake-005 - Local Obsidian State Staged
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
  - Mistake-005
  - M-005
  - Obsidian state staged
tags:
  - mistake
  - project/spx
  - topic/memory-vault
  - area/deploy
  - severity/medium
---

# Mistake-005 - Local Obsidian State Staged

> [!abstract] One-liner
> Local Obsidian state files can become dirty during normal vault browsing and should not be committed unless the task is explicitly about Obsidian configuration.

---

## What Can Happen

- `memory/.obsidian/graph.json` or similar UI state is staged with unrelated code or memory changes.
- A commit becomes noisy and harder for future agents to trust.
- Local editor preferences leak into shared project history.

---

## Root Cause

Using broad staging commands such as `git add .` can include local editor state that changed outside the actual task.

---

## Correct Pattern

Before staging:

```bash
git status --short
```

Stage explicit paths:

```bash
git add -- AGENTS.md package.json memory/00_Index/Memory-Quality-Score.md
```

Leave local-only files unstaged unless the user explicitly asked to change them.

---

## Resolution

Resolved on 2026-05-13 by:

- Adding [[Runbook-Deploy-Safety-Checklist]].
- Repeatedly leaving `memory/.obsidian/graph.json` unstaged during unrelated commits.
- Documenting explicit path staging as the required pattern.

---

## How AI Should Avoid This

- Treat `.obsidian/` files as local state unless the task is Obsidian plugin/config setup.
- Use explicit path staging.
- Mention any remaining unstaged local state in the final response if it is visible.
- Do not revert user/editor state without explicit instruction.

---

## Detection

Symptoms:

- `git status --short` shows `M memory/.obsidian/...`.
- `git diff --cached --stat` includes `.obsidian` for a non-config task.
- A session log or docs-only commit includes unexpected editor UI changes.

---

## Related

- [[Runbook-Deploy-Safety-Checklist]]
- [[Vault-Dashboard]]
- [[Memory-Vault-Principles]]
