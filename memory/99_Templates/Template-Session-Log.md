<%*
const topic = await tp.system.prompt("Session topic (kebab-case, e.g. Fix-Auto-Accept)");
const agent = await tp.system.suggester(
  ["Cascade", "Claude Code", "Codex", "Cursor", "Other"],
  ["cascade", "claude", "codex", "cursor", "other"],
  false,
  "Which agent?"
);
const project = await tp.system.prompt("Project tag (e.g. project/spx)");
const today = tp.date.now("YYYY-MM-DD");
const filename = `${today}-${topic}`;
await tp.file.rename(filename);
await tp.file.move(`/05_Agent_Session_Logs/${filename}`);
-%>
---
title: "<% today %> — <% topic.replace(/-/g, " ") %>"
type: session-log
session-date: <% today %>
agent: <% agent %>
duration-minutes: 
outcomes:
  - 
created: <% today %>
updated: <% today %>
tags:
  - session-log
  - <% project %>
---

# <% today %> — <% topic.replace(/-/g, " ") %>

> [!abstract] Summary
> 1–2 sentences. Future-you reads this first.

## Summary

- What changed overall.
- Why it mattered.

## Goal

What we set out to do.

## Log

- Step-by-step notes of what happened.
- Include tests, fixes, and notable observations.

## What Was Done

- [x] Task 1 → result
- [ ] Task 2 → carried over

## Verification

- [x] Hook/runtime check passed
- [x] Relevant local test passed
- [ ] Memory verify passed

## Follow-ups

- [ ] Follow-up 1
- [ ] Follow-up 2

## Files Touched

- `path/to/file.ts` — what changed and why

## Decisions Made

- Decision 1 — see [[ADR-NNN-...]] *(if formal)*

## Confidence Log

> [!important] Track claims where stated confidence differed from actual correctness.
> This helps future AI agents calibrate their confidence and avoid overconfidence traps.

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Example: "MOC-Home has no duplicate entries" | high | wrong — created duplicate row | Always re-read before claiming uniqueness |
| | | | |

## Insights / Learnings

> [!tip] Worth promoting to `07_Insights/`?
> If a learning shows up in 2+ sessions, write a proper note.

- Learning 1

## Open Issues / Follow-ups

- [ ] Follow-up 1

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [ ] All edited notes have updated `updated:` field
> - [ ] Wikilinks added to related notes
> - [ ] Tagged with ≥ 2 tags from taxonomy
> - [ ] No file with > 1 unrelated H2
> - [ ] Session log written (this file)

## References

- Commits: `<sha>...<sha>`
- Related sessions: [[YYYY-MM-DD-previous]]