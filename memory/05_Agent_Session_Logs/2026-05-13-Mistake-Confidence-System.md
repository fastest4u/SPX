---
title: "2026-05-13 — Mistake Registry + Confidence Tracking System"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 15
outcomes:
  - Created Mistake-006: PowerShell Bash Syntax on Windows
  - Created Mistake-007: Edit Without Verifying File Contents
  - Added Confidence Log section to session log template (Template-Session-Log.md)
  - Added Confidence Log rules to AGENTS.md with when-to-log / when-to-skip criteria
  - Added mistake escalation threshold to Mistakes README (1st=session log, 2nd=mistake, 3rd=runbook/ADR)
  - User explicitly requested: "ทุกครั้งที่ AI ผิด ให้บันทึกทันที"
  - memory:check clean on 83 files
created: 2026-05-13
updated: 2026-05-14
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/metacognition
  - topic/quality
thread: vault-bootstrap
related-sessions:
  - "[[2026-05-13-Multi-AI-Acceptance-Cascade]]"
---

# 2026-05-13 — Mistake Registry + Confidence Tracking System

> [!abstract] TL;DR
> User asked for two systems to make AI "self-aware" of its own errors: (1) record every mistake immediately, and (2) track confidence vs correctness. Created Mistake-006 (PowerShell syntax) and Mistake-007 (edit without reading file), added Confidence Log to session log template and AGENTS.md, and defined escalation rules for recurring errors.

---

## Goal

User requested:
1. *"เพิ่ม Mistake-003, 004... ทุกครั้งที่ AI ผิด ให้บันทึกทันที"*
2. *"เพิ่ม Confidence tracking ใน session log — 'ตอนตอบคำถามนี้ มั่นใจ high แต่ผิด' → AI จะระวังตัวเอง"*

---

## What Was Done

### #1 Mistake-006: PowerShell Bash Syntax on Windows

Recorded from today's session where `&&`, `tail`, and bash-isms failed in PowerShell:
- `cd ... && npm run ...` → `The token '&&' is not a valid statement separator`
- `... | tail -30` → `tail: The term 'tail' is not recognized`
- Resolution: use `Set-Location; command` and `Select-Object -Last`

### #2 Mistake-007: Edit Without Verifying File Contents

Recorded from today's session where editing `Awakened-AI-System.md` failed because `old_string` didn't match:
- Assumed file content without reading
- Edit tool rejected the replacement
- Resolution: always read file immediately before editing, copy-paste exact text

### #3 Confidence Log in Session Log Template

Added to `99_Templates/Template-Session-Log.md`:

```markdown
## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| "File contains exact string X" | high | wrong — string format differed | Read file before editing |
```

**Purpose:** Track claims where stated confidence differed from actual correctness. Creates a calibration dataset for future agents.

### #4 Confidence Log Rules in AGENTS.md

Added section `### Confidence Log (Session Logs)` with:
- **When to log:** high confidence + wrong, assumed file content, wrong OS syntax, user correction
- **When to skip:** trivial typos, user asked for risky attempt, external failures
- **Why it matters:** Overconfidence is a recurring AI failure mode

### #5 Mistake Escalation Threshold

Added to `08_Mistakes/README.md`:

| Occurrence | Action |
|---|---|
| 1st | Log in session Confidence Log |
| 2nd | Create or update Mistake note |
| 3rd | Create Runbook or update ADR |

### #6 Verification

- `npm run memory:check` → **0 errors / 0 warnings on 83 files**

---

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| "MOC-Home has no duplicate Glossary entry" | high | wrong — created duplicate row | Always re-read before claiming uniqueness |
| "Awakened-AI-System.md contains 'L4: Awakening' string" | medium | wrong — string format differed | Read file before editing |
| "PowerShell supports `&&` and `tail`" | high (implied) | wrong — multiple command failures | Check OS before assuming shell syntax |

---

## Files Touched

### Created (2)
- `memory/08_Mistakes/Mistake-006-PowerShell-Bash-Syntax-On-Windows.md`
- `memory/08_Mistakes/Mistake-007-Edit-Without-Verifying-File.md`

### Modified (3)
- `memory/99_Templates/Template-Session-Log.md` — added Confidence Log section
- `memory/AGENTS.md` — added Confidence Log rules
- `memory/08_Mistakes/README.md` — added escalation threshold and user request note

---

## Decisions Made

- **Log every mistake in Confidence Log, but only create Mistake note for recurring/non-trivial patterns.** This balances the user's "ทุกครั้ง" request with vault hygiene.
- **Escalation threshold: 1-2-3 rule.** Prevents mistake-note inflation while ensuring recurring errors get permanent prevention.
- **Confidence Log is mandatory, not optional.** AGENTS.md uses "MUST include" language.

---

## Open Issues / Follow-ups

- [x] Backfill Confidence Log into session logs from today that were written before this system existed.
- [x] Monitor if AI actually uses Mistake-006 and Mistake-007 to avoid recurrence.

---

## Quality Checks

> [!success] Verification
> - [x] `npm run memory:check` → 0 errors / 0 warnings on 83 files
> - [x] 2 new mistake notes created with proper frontmatter
> - [x] Session log template updated with Confidence Log
> - [x] AGENTS.md updated with confidence tracking rules
> - [x] Mistakes README updated with escalation rules
> - [x] Session log written (this file) with Confidence Log populated

---

## References

- [[Mistake-006-PowerShell-Bash-Syntax-On-Windows]]
- [[Mistake-007-Edit-Without-Verifying-File]]
- [[08_Mistakes/README]] — mistake registry index
- [[AGENTS]] — confidence log rules
- [[Template-Session-Log]] — updated template
