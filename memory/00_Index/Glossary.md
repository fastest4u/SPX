---
title: Glossary
type: glossary
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - reference
aliases:
  - Vocabulary
  - Terms
---

# 📖 Glossary

> [!info] Purpose
> Shared vocabulary for human + AI. When a term has a specific meaning **in this vault**, define it here.

---

## A

### Agent
An LLM-powered assistant that can read, decide, and act — e.g. Claude Code, Cascade, Codex, Cursor.

### ADR (Architecture Decision Record)
A short document that records *one* architectural choice — context, decision, consequences. Stored in `04_Architecture_Decisions/`. See [[Template-ADR]].

### Atomic Markdown Memory
The principle of "**one fact per file**" so files compose like LEGO bricks. From [[LeafBox-03-Obsidian-Memory-for-AI]].

### Auto-Accept
SPX-specific: when a poller automatically accepts a bidding request that matches enabled rules. Recorded in `auto_accept_history` table.

---

## C

### CLAUDE.md
Anthropic-specific entry-point file with project rules. In *this* vault we use [[AGENTS.md]] as the tool-agnostic equivalent.

### Compactor
A periodic pass where AI reads session logs and promotes important parts to `07_Insights/`. Prevents the vault from becoming a "note graveyard".

### Context Rot
Quality degradation when too much irrelevant context is loaded into the LLM. Symptom: AI getting *less* useful as more is added. Counter-measure: [[Context-Rot-Prevention]].

### Convention-as-Schema
Idea that filesystem layout + naming rules can replace a database schema. Quote: "Convention is the new schema. Filesystem is the new index."

---

## D

### Dataview
Obsidian plugin that queries note metadata (frontmatter, inline fields, tags) like a database. Optional but powerful — enables auto-generated MOC pages.

### Dreams (Claude feature)
Claude's memory-maintenance pass: re-reads old sessions, extracts insights, deduplicates. Conceptually = automated compactor.

---

## M

### MCP (Model Context Protocol)
Open protocol from Anthropic that lets MCP servers expose tools (read files, query DB, etc.) to AI clients. The vault is accessed via the **Obsidian MCP Server**.

### Memory Vault
A structured collection of Markdown files designed to be **read by AI** across sessions. This entire repository is one.

### MOC (Map of Content)
A note that links to other notes — a manual table of contents. See [[MOC-Home]].

### Multi-Agent Orchestration
A coordinator agent breaks one big task into sub-tasks for specialist agents (security, testing, docs, etc.), then merges their outputs.

---

## O

### Outcomes (Claude feature)
Instead of "do task X", you give Claude a **rubric** of what success looks like (tests pass, docs updated, risks reviewed). Agent iterates until it passes.

---

## P

### Poller
SPX-specific: the long-running loop in `src/controllers/poller.ts` that calls the bidding API on an interval, detects changes, and notifies / auto-accepts.

### Project DNA
The accumulated set of decisions, conventions, and tribal knowledge that makes a project *this* project and not another. The vault preserves it.

---

## R

### RAG (Retrieval-Augmented Generation)
Pattern where LLM is given retrieved documents as context. This vault is **NOT** a RAG system — it's a *personal context layer*, complementary to RAG.

### Routines (Claude feature)
Scheduled / event-triggered AI runs (cron, webhook, GitHub event). Turns repeatable manual prompts into automation.

---

## S

### Session Log
A note in `05_Agent_Session_Logs/` that records what an AI did in one working session — tasks, decisions, files changed, follow-ups. See [[Template-Session-Log]].

### Supersedes
Relationship between two ADRs: a new decision replaces an older one. Both files link back-and-forth (`supersedes:` and `superseded-by:`).

---

## V

### Vault
The root folder containing this Memory Vault. Opened in Obsidian, mounted via the Obsidian MCP server.

---

## W

### Wikilink
Obsidian's `[[Note Name]]` syntax. Survives renames automatically — **prefer over Markdown links** for in-vault references.

### Working Context
A note that captures "what is the AI thinking about right now?" — typically a single file or task. Lives at `00_Index/Working-Context.md` (when active).

---

## Related

- [[AGENTS.md]] — full conventions
- [[MOC-Home]] — navigation hub
- [[Memory-Vault-Principles]] — philosophy

%% Add new terms here when you find yourself defining them twice in chat. %%
