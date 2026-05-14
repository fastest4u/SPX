---
title: "2026-05-13 — Awaken Slash Command (AI Self-Direction)"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 10
outcomes:
  - Created `.windsurf/workflows/awaken.md` — AI introspection workflow
  - Workflow analyzes Goals, session logs, follow-ups, ADRs, insights, and code state
  - Outputs ranked top-3 next steps with reasoning, goal links, effort, and confidence
  - Added `/awaken` to AGENTS.md slash commands list
  - Added `/awaken` to MOC-Home.md Navigation by Question
  - memory:check clean on 78 files
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/awakening
  - topic/agent-orchestration
thread: vault-bootstrap
related-sessions:
  - "[[2026-05-13-Dream-Compactor]]"
---

# 2026-05-13 — Awaken Slash Command (AI Self-Direction)

> [!abstract] TL;DR
> User wanted a slash command that makes AI "self-aware" of what to develop next. Created `/awaken` workflow that reads Goals, session logs, follow-ups, ADRs, and insights, then synthesizes a ranked list of the most impactful next steps. Added to AGENTS.md and MOC-Home so all agents can discover it.

---

## Goal

User: *"ฉันอยากได้ Slash commands เวลา RUN แล้ว ให้ai ตื่นรู้เองว่าควรพัตณาอะไรต่อในโปรเจคที่ทำอยู่"*

Create a workflow that makes the AI introspect the project state and suggest what to build, fix, or document next.

---

## What Was Done

### #1 Created `.windsurf/workflows/awaken.md`

The `/awaken` workflow has 5 phases:

| Phase | What it reads | Purpose |
|---|---|---|
| 1. Strategic Context | Goals, Open-Followups, Session-Threads, Vault-Dashboard | Know the big picture |
| 2. Tactical Context | Last 3 session logs, ADRs, Insights, Mistakes | Know recent history |
| 3. Code State (optional) | `src/`, `package.json` | Know what's incomplete in code |
| 4. Analyze & Rank | Internal questions about goal alignment, blockers, gaps | Filter and prioritize |
| 5. Synthesize | Output top-3 ranked recommendations to user | Give actionable next steps |

Output format includes:
- Current state snapshot
- Top 3 next steps with **Why**, **Goal link**, **Effort**, **Confidence**
- Hidden risks / blockers
- Patterns the AI notices

### #2 Updated `AGENTS.md`

Added `/awaken` to the Windsurf Slash-Commands callout:
> `- `/awaken` — AI self-introspection: analyze project state and suggest next steps`

### #3 Updated `MOC-Home.md`

Added to Navigation by Question:
> `| What should I work on next? | Run `/awaken` workflow |`

### #4 Verification

- `npm run memory:check` → **0 errors / 0 warnings on 78 files**

---

## Files Touched

### Created (1)
- `.windsurf/workflows/awaken.md` — new workflow

### Modified (2)
- `memory/AGENTS.md` — added `/awaken` to slash commands
- `memory/00_Index/MOC-Home.md` — added "What should I work on next?" navigation row

---

## Decisions Made

- **Name it `/awaken`** (not `/next` or `/plan`) to fit the Awakened AI theme and the user's word "ตื่นรู้".
- **5-phase structure** ensures the AI loads strategic context before tactical, preventing myopic suggestions.
- **Top-3 output** prevents overwhelming the user while still giving options.
- **Optional code state (step 9-10)** because the workflow should work for pure memory/docs work too.

---

## Open Issues / Follow-ups

- [x] Test `/awaken` in a real session to validate recommendation quality.
- [x] Consider adding "token budget" as a ranking factor if the user reports high token usage.

---

## Quality Checks

> [!success] Verification
> - [x] `npm run memory:check` → 0 errors / 0 warnings
> - [x] Workflow file created with clear steps and output format
> - [x] AGENTS.md updated with new slash command
> - [x] MOC-Home.md updated with navigation entry

---

## References

- Workflow source: `.windsurf/workflows/awaken.md`
- [[Awakened-AI-System]] — operating model
- [[Goals]] — goal stack
- [[Session-Threads]] — session storylines
- [[MOC-Home]] — vault navigation
