---
description: Load Memory Vault context at session start — read vault constitution, scan recent sessions, summarize state.
---

# /session-start — Load Memory Vault

This workflow primes the AI with persistent project memory before any work begins.

## Steps

1. **Read the vault constitution**
   - Open `memory/AGENTS.md` (vault rules, conventions, taxonomy).

2. **Read the project-level rules**
   - Open `memory/01_Project_Rules/SPX-Project-Rules.md`.

3. **Scan recent context (last 5 session logs)**
   - List files in `memory/05_Agent_Session_Logs/` sorted by date DESC.
   - Read the **top 5** most recent session logs.
   - Pay attention to:
     - `outcomes:` field
     - `Open Issues / Follow-ups` sections
     - Cross-links to ADRs

4. **Read active ADRs**
   - Open every file in `memory/04_Architecture_Decisions/`.
   - Note any ADR with `status: accepted` — these constrain decisions.
   - Skip ADRs with `status: deprecated` or `status: superseded`.

5. **Check for open follow-ups**
   - Search across `memory/05_Agent_Session_Logs/` for unchecked tasks (`- [ ]`).
   - Collect them into a short list.

6. **Summarize to the user**
   - Output in this format:

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

7. **Do NOT start coding yet** — wait for the user's actual request.

## Rules

- Skip the workflow if the user explicitly says "skip context" or "fresh start".
- If `memory/` doesn't exist, tell the user and offer to bootstrap (see `memory/README.md`).
- Keep the summary **under 200 lines** — link to files rather than dumping them.
- Use the `obsidian` MCP server if available (faster searches), otherwise filesystem reads.

## Reference

- `memory/AGENTS.md` — vault constitution
- `memory/00_Index/MOC-Home.md` — navigation hub
- `memory/00_Index/Vault-Dashboard.md` — live health board
