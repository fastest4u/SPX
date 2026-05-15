---
title: AI Tool Profiles - How Each Agent Reads the Vault
type: reference
status: active
last-verified: 2026-05-14
verified-by: codex
source: file:memory/AGENTS.md + file:opencode.json + file:.agents/skills + file:.codex/hooks.json + project experience
confidence: high
created: 2026-05-13
updated: 2026-05-14
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
aliases:
  - AI Tool Cheat Sheet
  - Agent Setup Guide
---

# AI Tool Profiles

> [!abstract] Purpose
> Quick reference for setting up any AI tool to read SPX Memory Vault correctly. Each tool has different capabilities for slash commands, file reading, and session management.

---

## Cascade (Windsurf)

| Feature            | Support                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **Slash commands** | `/session-start`, `/session-end`, `/awaken`, `/self-check`, `/multi-perspective`, `/dream`, `/review` |
| **Auto-log**       | Yes — mandatory after meaningful work                                                                 |
| **Workflow files** | Reads `.windsurf/workflows/*.md`                                                                      |
| **Best practice**  | Always run `/session-start` before work; agent auto-reads vault                                       |

**Setup:** No manual setup needed. Cascade auto-detects `.windsurf/workflows/`.

**Session start:**
```
/session-start
```

**Session end:**
```
/session-end
```

---

## Claude Code (Anthropic)

| Feature            | Support                                          |
| ------------------ | ------------------------------------------------ |
| **Slash commands** | No native slash commands                         |
| **Auto-log**       | Manual — must prompt agent to write session log  |
| **Workflow files** | Can read if explicitly pointed to file           |
| **Best practice**  | Explicit prompt to read `memory/AGENTS.md` first |

**Setup:** Add to system prompt or first message:
```
Before working, read these files in order:
1. memory/AGENTS.md
2. memory/00_Index/MOC-Home.md
3. memory/00_Index/Goals.md
4. Last 3 session logs in memory/05_Agent_Session_Logs/
```

---

## Cursor

| Feature | Support |
|---|---|
| **Slash commands** | Yes — `.cursor/commands/*.md` (`/session-start`, `/awaken`, `/self-check`, `/multi-perspective`, `/dream`, `/session-end`) |
| **Auto-log** | Semi-automatic — `hooks.json` runs `session-start.mjs` on start, `session-end-automation.mjs` on end, and `self-check.mjs` before risky prompts via keyword matcher |
| **Workflow files** | Reads `.cursor/commands/*.md` and `.cursor/rules/*.mdc` |
| **Best practice** | Cursor rules auto-load from `.cursor/rules/`; commands are manually invoked |

**Setup:** No manual setup needed. Cursor auto-detects `.cursor/rules/*.mdc`.

**Commands:**
```
/session-start
/awaken
/self-check
/multi-perspective
/dream
/session-end
```

**Auto-hooks:**
- `sessionStart` → injects Memory Vault bootstrap context automatically.
- `beforeSubmitPrompt` → runs self-check when prompt matches production keywords (deploy, schema, db, auth, secret, etc.).
- `sessionEnd` → analyzes latest session log sections, open tasks, and Multi-AI acceptance stats.
- `stop` → reminds about session log completeness.

**Cursor rules:**
- `workflows.mdc` — general workflow guidance.
- `windsurf-workflows.mdc` — maps Windsurf workflows to Cursor equivalents.
- `pordee.mdc` — Thai terse response mode.

---

## Codex (OpenAI)

| Feature            | Support                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Slash commands** | Built-in Codex commands plus repo-local SPX skills (`$spx-*`); Codex app may list enabled skills in the slash menu                  |
| **Auto-log**       | Hook-assisted closeout via `.codex/hooks.json`; still writes session logs through normal agent work, not silent file writes         |
| **Workflow files** | Reads root `AGENTS.md`, Memory Vault files, `.agents/skills/*/SKILL.md`, and `.codex/hooks.json`                                    |
| **Best practice**  | Start Codex from the repo root so hooks and skills are discovered; hooks inject startup/self-check/closeout reminders automatically |

**Setup:** Repo-local Codex skills live under `.agents/skills/`. Codex scans `.agents/skills` from the working directory up to the repo root, so start Codex from `C:\Users\Server\Desktop\SPX` or a subfolder inside the repo.

**SPX skill commands:**
```
$spx-session-start
$spx-awaken
$spx-self-check
$spx-multi-perspective
$spx-dream
$spx-session-end
$spx-memory-verify
```

**Note:** These are Codex Agent Skills, not custom CLI-native slash commands. In CLI/IDE, invoke them with `$skill-name` or mention the name naturally. In the Codex app, enabled skills can appear in the slash command list.

**Auto-hooks:**
- `SessionStart` -> injects SPX Memory Vault startup context and recent session names.
- `UserPromptSubmit` -> injects retrieval/self-check context and blocks obvious pasted secrets.
- `PreToolUse` / `PermissionRequest` -> blocks dangerous commands such as `git reset --hard`, recursive deletes, `.env` reads, secret env prints, and destructive DB DDL.
- `PostToolUse` -> reminds after file edits or verification commands.
- `Stop` -> continues the turn if meaningful repo changes need a fresh session log or verification before final response.

---

## OpenCode

| Feature            | Support                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| **Slash commands** | `/session-start`, `/awaken`, `/session-end`, `/memory-verify`, `/self-check`, `/multi-perspective`, `/dream` |
| **Auto-log**       | Command-assisted via `/session-end`; still mandatory after meaningful work |
| **Workflow files** | Uses `opencode.json` command templates and root `AGENTS.md` instructions   |
| **Best practice**  | Start with `/session-start`; end meaningful work with `/session-end`       |

**Setup:** Repo-local `opencode.json` registers the Memory Vault commands and includes root `AGENTS.md` as an instruction file. Restart OpenCode after editing `opencode.json`; running sessions do not hot-reload config.

**Session start:**
```
/session-start
```

**Awakened review:**
```
/awaken
```

**Session end:**
```
/session-end
```

**Memory gate:**
```
/memory-verify
```

---

## GitHub Copilot Chat

| Feature | Support |
|---|---|
| **Slash commands** | Limited (`/explain`, `/fix`, `/tests`, etc.) |
| **Auto-log** | No — no file write capability in chat |
| **Workflow files** | No direct file reading in chat |
| **Best practice** | Use `@workspace` for code context; memory vault not directly accessible |

**Note:** Copilot Chat is **not suitable** for vault-aware work because it cannot write session logs or read arbitrary markdown files.

---

## Summary Table

| Tool | Slash Commands | Auto-Log | Vault Read | Recommended? |
|---|---|---|---|---|
| **Cascade** | Yes (7 workflows) | Yes | Automatic | ⭐ Primary |
| **Claude Code** | No | Manual | Explicit prompt | ✅ Good |
| **Cursor** | Yes (6 commands) | Semi-auto via hooks | Automatic via hooks + rules | ✅ Good |
| **Codex** | Built-in + 7 SPX skills | Hook-assisted | Automatic via `AGENTS.md` + `.agents/skills` + `.codex/hooks.json` | ✅ Good |
| **OpenCode** | Yes (7 commands) | Command-assisted | Automatic via `AGENTS.md` + commands | ✅ Good |
| **Copilot Chat** | Limited | No | Limited | ❌ Skipped — lacks file write and arbitrary read |

---

## Multi-AI Acceptance Test

To verify a new AI tool can use the vault:

1. Ask it to read `memory/AGENTS.md`
2. Ask it to list active goals from `memory/00_Index/Goals.md`
3. Ask it to find the last session log and summarize it
4. Ask it to create a test note in `memory/00_Index/Inbox.md`

If all 4 pass → tool is vault-ready.

Record results: [[Multi-AI-Acceptance-Results]]

---

## Related

- [[AGENTS]] — Vault constitution
- [[MOC-Home]] — Navigation hub
- [[Session-Threads]] — Session log grouping
- [[Multi-AI-Acceptance-Results]] — Test results registry
