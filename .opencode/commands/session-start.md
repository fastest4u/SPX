---
description: Load Memory Vault context at session start — read vault constitution, scan recent sessions, summarize state.
---

# /session-start — Load Memory Vault

This workflow primes the AI with persistent project memory before any work begins.

## When To Run

- At the start of every SPX session.
- When switching to SPX context from another project.

## Steps

1. **Read the vault constitution**
   - Open `memory/AGENTS.md` (vault rules, conventions, taxonomy).

2. **Read core identity and navigation**
   - Open `memory/00_Index/MOC-Home.md` — navigation hub.
   - Open `memory/AGENT-IDENTITY.md` — role, beliefs, limits.
   - Open `memory/00_Index/Goals.md` — active goal stack.

3. **Read the project-level rules**
   - Open `memory/01_Project_Rules/SPX-Project-Rules.md`.

4. **Scan recent context (last 5 session logs)**
   - List files in `memory/05_Agent_Session_Logs/` sorted by date DESC.
   - Read the **top 5** most recent session logs.
   - Pay attention to:
     - `outcomes:` field
     - `Open Issues / Follow-ups` sections
     - Cross-links to ADRs

5. **Read active ADRs**
   - Open every file in `memory/04_Architecture_Decisions/`.
   - Note any ADR with `status: accepted` — these constrain decisions.
   - Skip ADRs with `status: deprecated` or `status: superseded`.

6. **Check for open follow-ups**
   - Search across `memory/05_Agent_Session_Logs/` for unchecked tasks (`- [ ]`).
   - Collect them into a short list.

7. **Task-area retrieval**
   - If the user named a task area, retrieve the matching runbook or memory cluster from the retrieval table in `memory/AGENTS.md`.

8. **Summarize to the user (Thai)**

   ```
   ## 🧠 Memory Vault Loaded

   **Vault stats:**
   - Vault: `memory/` (XX files)
   - Last session: <YYYY-MM-DD> — <topic>
   - Active ADRs: <count>

   **Recent decisions:**
   - <bullet 1>
   - <bullet 2>

   **Open follow-ups:**
   - [ ] <task 1> (from <session log>)
   - [ ] <task 2> (from <session log>)

   **Ready to continue. What's the goal for this session?**
   ```

9. **Do NOT start coding yet** — wait for the user's actual request.

## Rules

- Skip the workflow if the user explicitly says "skip context" or "fresh start".
- If `memory/` doesn't exist, tell the user and offer to bootstrap.
- Keep the summary **under 200 lines** — link to files rather than dumping them.

## Reference

- `memory/AGENTS.md` — vault constitution
- `memory/00_Index/MOC-Home.md` — navigation hub
- `memory/00_Index/Vault-Dashboard.md` — live health board
