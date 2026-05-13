---
description: Save Memory Vault state at session end — write session log, update MOC, surface follow-ups.
---

# /session-end — Save Session to Memory Vault

This workflow persists the current session into long-term memory so the next session can resume seamlessly.

## When To Run

- Before ending a session.
- After completing a meaningful chunk of work (PR merged, feature done, bug fixed).
- When the user says "save this" / "log this session" / "we're done".

## Steps

1. **Determine the session topic**
   - Pick a short kebab-case description: `Fix-Auto-Accept`, `Add-Discord-Embed`, `Refactor-Poller`, etc.
   - Format: `YYYY-MM-DD-Topic.md` (today's date).

2. **Pick the agent identity**
   - Cascade (Windsurf) → `agent: cascade`
   - Claude Code → `agent: claude`
   - Codex → `agent: codex`
   - Cursor → `agent: cursor`

3. **Create the session log file**
   - Path: `memory/05_Agent_Session_Logs/YYYY-MM-DD-Topic.md`
   - Use this template (fill **all** placeholders):

   ```yaml
   ---
   title: "<YYYY-MM-DD> — <Topic with spaces>"
   type: session-log
   session-date: <YYYY-MM-DD>
   agent: <cascade | claude | codex | cursor | other>
   duration-minutes: <estimate>
   outcomes:
     - <concrete outcome 1>
     - <concrete outcome 2>
   created: <YYYY-MM-DD>
   updated: <YYYY-MM-DD>
   tags:
     - session-log
     - project/spx
     - <other relevant tag>
   ---
   ```

4. **Fill the body** (use this skeleton):

   ```markdown
   # <YYYY-MM-DD> — <Topic>

   > [!abstract] TL;DR
   > 1–2 sentences. Future-you reads this first.

   ## Goal
   What we set out to do.

   ## What Was Done
   - [x] Task 1 → result
   - [ ] Task 2 → carried over

   ## Files Touched
   - `path/to/file.ts` — what changed and why

   ## Decisions Made
   - Decision 1 — see [[ADR-NNN-...]] *(if formal)*

   ## Insights / Learnings
   - Learning 1
   - Learning 2

   ## Open Issues / Follow-ups
   - [ ] Follow-up 1
   - [ ] Follow-up 2

   ## Quality Checks
   - [x] All edited notes updated `updated:` field
   - [x] Wikilinks added to related notes
   - [x] Tagged with ≥ 2 tags from taxonomy
   - [x] Session log written (this file)

   ## References
   - Commits: `<sha>...<sha>`
   - Related sessions: [[YYYY-MM-DD-previous]]
   - ADRs touched: [[ADR-NNN-...]]
   ```

5. **Check for promotion candidates**
   - Did any insight from this session repeat from previous sessions?
   - If yes → consider creating `memory/07_Insights/<Topic>.md` and link both sessions.

6. **Update MOC if structure changed**
   - If you added new folders → update `memory/00_Index/MOC-Home.md`.
   - If a Dataview query needs updating → edit `memory/00_Index/MOC-Home.md`.

7. **Report to user**

   ```
   ## ✅ Session saved

   **Log:** `memory/05_Agent_Session_Logs/YYYY-MM-DD-Topic.md`
   **Outcomes:** <count>
   **Open follow-ups:** <count>

   Next session can resume by running `/session-start`.
   ```

## Rules

- **Be concrete** — "fixed bug" is bad. "Fixed race condition in poller's tick(): SSE listeners weren't disposed before re-init" is good.
- **Link, don't dump** — reference files, ADRs, commits instead of pasting content.
- **Use wikilinks** `[[...]]` for in-vault references (Obsidian-friendly).
- **Never edit old session logs** — they're append-only history. If you need to correct something, write a new note.
- Use the `obsidian` MCP server's `obsidian_write_note` if available (handles frontmatter validation).

## Reference

- Template: `memory/99_Templates/Template-Session-Log.md`
- Vault rules: `memory/AGENTS.md`
- Why we log: `memory/07_Insights/Memory-Vault-Principles.md`
- Anti-rot strategy: `memory/07_Insights/Context-Rot-Prevention.md`
