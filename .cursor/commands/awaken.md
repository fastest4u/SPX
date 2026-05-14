---
description: Awakened AI introspection — analyze project state and suggest the next most impactful development step
---

# /awaken — Awakened AI Next-Step Introspection

> Make the AI self-aware of the project's current state and suggest what to build, fix, or document next.

## When To Run

- Start of a work session when you do not know what to do next.
- After completing a feature and wondering what to do next.
- When feeling stuck and needing the system to surface gaps.
- Weekly planning for a ranked list of highest-impact next steps.

## Steps

1. Read `memory/AGENTS.md`.
2. Read `memory/00_Index/MOC-Home.md`.
3. Read `memory/00_Index/Goals.md`.
4. Read `memory/00_Index/Open-Followups.md`.
5. Read `memory/00_Index/Session-Threads.md`.
6. Read `memory/00_Index/Vault-Dashboard.md`.
7. Read the last 3 session logs in `memory/05_Agent_Session_Logs/`.
8. Read `memory/04_Architecture_Decisions/` for accepted ADRs.
9. Read `memory/07_Insights/` and `memory/08_Mistakes/`.
10. If the user is asking about code, skim `src/` and `package.json`.

## Output Format

Return a concise analysis with:
- Current state snapshot
- Top 3 next steps ranked by impact
- Hidden risks or blockers
- One pattern you notice

## Rules

- Do not suggest work already completed.
- Prefer concrete actions over vague advice.
- Link recommendations to goals, session logs, ADRs, or runbooks.
- Respect existing repo workflow and accepted decisions.
- Keep the recommendation grounded in source files and vault notes.
