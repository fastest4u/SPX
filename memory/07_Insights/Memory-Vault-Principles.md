---
title: Memory Vault Principles
type: insight
status: stable
confidence: high
derived-from:
  - "[[LeafBox-01-Memory-Vault]]"
  - "[[LeafBox-03-Obsidian-Memory-for-AI]]"
created: 2026-05-13
updated: 2026-05-13
tags:
  - insight
  - topic/memory-vault
  - topic/principles
aliases:
  - Vault Philosophy
  - Memory Principles
---

# Memory Vault Principles

> [!abstract] TL;DR
> 7 principles that turn a folder of `.md` files into a **persistent brain** for AI + human teams. Distilled from [[LeafBox-01-Memory-Vault]] + [[LeafBox-03-Obsidian-Memory-for-AI]].

---

## The 7 Principles

### 1. Persistence Over Repetition

> [!note] Problem
> Every new AI session = start from zero. The user re-explains project, conventions, history.

> [!success] Principle
> If you've explained something **twice**, write it down. Future sessions inherit it for free.

**Operational rule:** When you find yourself typing "remember last time..." → that's a signal to write a note.

---

### 2. Plain Markdown First

> [!note] Problem
> Lock-in to proprietary memory systems (database, vector store, vendor APIs).

> [!success] Principle
> **Markdown files in a folder.** Human-readable. Editor-agnostic. Git-trackable. Portable across AI tools.

**Trade-off accepted:** No semantic search out-of-the-box. We rely on structure + tags instead.

---

### 3. Atomic — One Fact Per File

> [!note] Problem
> Big monolithic notes hide information. AI can't selectively retrieve a piece.

> [!success] Principle
> **One file = one topic = one fact set.** Split rather than merge.

**Heuristic:** If a note has multiple `## H2` sections that could each stand alone → split.

> [!example]
> Bad: `Notify.md` with API, components, decisions, history all in one file.
> Good: `Notify-API.md`, `Notify-Discord-Component.md`, `ADR-001-Notify-Rules-Storage.md`, `Notify-History.md`.

---

### 4. Convention as Schema

> [!quote] SPEC-v3
> "Convention is the new schema. Filesystem is the new index."

> [!success] Principle
> Filesystem layout + naming + frontmatter **is** the database schema. Enforced by convention, not by software.

**Implication:** Naming rules matter. Frontmatter is mandatory. See [[AGENTS.md#Folder Conventions]].

---

### 5. Layer Separation (Sources / Memory / Schema)

> [!success] Principle
> Three distinct layers, edited by different actors:
>
> | Layer | Folder | Editor |
> |---|---|---|
> | Sources (raw) | `06_Sources/` | Human |
> | Memory (distilled) | `01_*` to `05_*`, `07_Insights/` | AI + Human |
> | Schema (rules) | `AGENTS.md`, `99_Templates/` | Human only |

**Why?** Source preservation, distilled re-usable knowledge, immutable rules — three different change cadences.

---

### 6. Retrieval > Stuffing

> [!quote] Cloudflare on Agent Memory
> "Context window getting bigger ≠ better. The real game is who retrieves the **right** context at the **right** time."

> [!success] Principle
> Don't dump everything into prompt. Build the vault so the **right note** is **findable** via tags, paths, wikilinks.

**Counter-pattern:** "Just include all docs in context" → causes [[Context-Rot-Prevention|context rot]].

---

### 7. Maintenance is the Job

> [!note] Problem
> Note graveyard — vault grows, no one prunes. AI starts ignoring it. Trust collapses.

> [!success] Principle
> Treat the vault like code. Schedule compactor passes. Deprecate, don't delete. See [[Context-Rot-Prevention]].

**Operational rules:**
- End-of-session log
- Monthly compactor
- Quarterly tag/link audit
- Supersede chain for ADRs

---

## Anti-Principles (what NOT to do)

> [!failure] Avoid
> - ❌ Dump entire chat logs into vault.
> - ❌ Copy-paste API responses verbatim.
> - ❌ Mix multiple topics in one file.
> - ❌ "I'll add tags later" — tag now or don't add.
> - ❌ Treat the vault as backup of code (vault explains *why*, code shows *what*).

---

## The Test (Did We Get It Right?)

> [!question] Ask after every session
> 1. Could a **new agent** read [[AGENTS.md]] + [[MOC-Home]] and start working productively?
> 2. Did I add information that **future-me** will thank me for?
> 3. Did I tag / link it so it's findable in 3 months?
>
> If all yes → vault is healthy.

---

## When These Principles Conflict

> [!warning] Conflicts will happen
> Example: "atomic" says split everything, but "retrieval > stuffing" says don't make AI hop 10 links.
>
> **Tie-breaker:** Optimise for **the agent reading at session N+1**, not the writer at session N.

---

## Related

- [[AGENTS.md]] — operationalization of these principles
- [[Context-Rot-Prevention]] — principle #7 expanded
- [[Agent-Orchestration-Patterns]] — how memory feeds orchestration
- [[MOC-Home]] — navigation

## Sources

- [[LeafBox-01-Memory-Vault]]
- [[LeafBox-03-Obsidian-Memory-for-AI]]
