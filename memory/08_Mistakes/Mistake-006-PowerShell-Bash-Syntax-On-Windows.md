---
title: Mistake-006 — PowerShell Bash Syntax on Windows
type: mistake
severity: low
status: resolved
occurred-date: 2026-05-13
resolved-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-14
agent: cascade
area: topic/tooling
confidence: high
aliases:
  - Mistake-006
  - M-006
  - PowerShell Syntax
tags:
  - mistake
  - project/spx
  - topic/tooling
  - severity/low
---

# Mistake-006 — PowerShell Bash Syntax on Windows

> [!abstract] One-liner
> Used `&&`, `tail`, `cd && cmd`, and other POSIX shell idioms in PowerShell commands on Windows, causing repeated command failures.

---

## What Happened

During the session, multiple commands failed because bash syntax was used in PowerShell:

| Attempt | Command | Error |
|---|---|---|
| 1 | `npm run memory:check 2>&1 \| tail -30` | `tail: The term 'tail' is not recognized` |
| 2 | `cd ... && npm run memory:check` | `The token '&&' is not a valid statement separator` |
| 3 | `npm run memory:check 2>&1 \| Select-Object -Last 30` | Started with garbage char `แnpm` (encoding issue) |

All three failed before finally using `Set-Location; command` syntax.

---

## Root Cause

- AI training data is heavily skewed toward Linux/macOS bash.
- PowerShell uses `;` for sequencing, `Select-Object -Last` for tail, and `Set-Location` for cd.
- Windows doesn't have `tail` by default.

---

## Correct Pattern

**PowerShell (Windows):**

```powershell
Set-Location C:\Users\Server\Desktop\SPX
npm run memory:check
# Or inline:
Set-Location C:\Users\Server\Desktop\SPX; npm run memory:check
```

**NOT this:**

```powershell
# ❌ && is not valid in PowerShell
cd C:\Users\Server\Desktop\SPX && npm run memory:check

# ❌ tail doesn't exist on Windows
npm run memory:check 2>&1 | tail -30

# ❌ cd is an alias, but && still breaks
cd C:\... && npm run ...
```

---

## Time Lost

~2 minutes per failed attempt × 3 attempts = ~6 minutes of retries and re-typing.

---

## How AI Should Avoid This

> [!tip] Windows Command Checklist
> 1. **Check OS** — Windows = PowerShell; Linux/macOS = bash.
> 2. **Use `;` not `&&`** for command chaining in PowerShell.
> 3. **Use `Set-Location` (or `cd`) but never with `&&`**.
> 4. **Avoid `tail`, `grep`, `awk`** on Windows unless WSL or Git Bash is confirmed.
> 5. **Prefer `Out-String` or `Select-Object`** for output filtering.

---

## How To Detect Recurrence

- Command fails with `The token '&&' is not a valid statement separator`
- Command fails with `<tool> is not recognized`
- PowerShell errors that look like bash syntax errors

---

## Related

- Session log: [[2026-05-13-Session-Threads-And-AI-Tool-Profiles]]
- Similar pattern: any tool assumption based on dominant OS in training data
