---
title: "LeafBox Digest — AI ที่จำเราได้ อาจเปลี่ยนวิธีทำงานกับ AI ไปเลย"
type: source
source-author: LeafBox Digest (นิว)
source-url: 
source-date: 2026-05
ingested-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
tags:
  - source
  - topic/memory-vault
  - topic/obsidian
  - language/thai
aliases:
  - Obsidian Memory for AI Article
  - SPEC-v3 Reference
---

# LeafBox-03 — Obsidian Memory for AI

> [!abstract] Core thesis
> เปลี่ยน Obsidian vault ที่เป็น Markdown อยู่แล้ว → **persistent memory** ที่ AI assistant อ่านได้ทุก session. **ไม่ต้องมี database, vector store, server, lock-in** — แค่จัด vault ให้เป็นระบบ.

## Source Info

- **Author:** LeafBox Digest (นิว)
- **References:** Project **"Obsidian Memory for AI"** + its **SPEC-v3**
- **Pattern name:** Atomic Markdown Memory

## Verbatim Key Quote

> "Convention is the new schema. Filesystem is the new index."

→ ถ้าตั้ง convention ของไฟล์ดีพอ ไม่ต้องมี database

## 5 Key Points (Original Structure)

### 1. ปัญหาคือ AI "เริ่มจากศูนย์" บ่อยเกินไป

> AI assistant ลืมทุกอย่างระหว่าง session

**Analogy ที่ดีมาก:**
> เหมือนมี intern เก่งมาก แต่ทุกเช้าตื่นมาแล้วจำไม่ได้ว่าเมื่อวานทำอะไรไป.

### 2. 3-Layer Memory Architecture

| Layer | Folder | Content | Edited by |
|---|---|---|---|
| **L1** | `sources/` | Raw input — articles, notes, podcasts, book highlights | Human |
| **L2** | `memory/` | Wiki ที่ AI ช่วย maintain: people, projects, decisions, insights, glossary, working context | AI + Human |
| **L3** | `CLAUDE.md` / schema | Rules ว่า AI จะอ่านอะไร ตอบสไตล์ไหน ดูแล memory ยังไง | Human (rare) |

> "เหมือนทำสมองภายนอกให้ AI แต่สมองนี้เป็นไฟล์ Markdown ที่เราเปิดอ่านเองได้ทุกบรรทัด"

### 3. ไม่ใช่ RAG — เป็น Personal Context Layer

> Obsidian Memory for AI ไม่ได้มาแทน vector DB, Mem0, Zep, Letta

**What it captures:**
- เราคือใคร
- เราชอบทำงานแบบไหน
- โปรเจกต์ไหนกำลัง active
- เคยตัดสินใจอะไรไปแล้ว
- คุยกับคนไหนไว้เรื่องอะไร
- Insight ไหนจาก session ก่อนควรถูกเก็บถาวร

> "RAG ใหญ่ๆ ค้นเอกสารเก่ง แต่ไม่ได้เข้าใจ 'บริบทชีวิตการทำงาน' ของเราเสมอไป"

### 4. SPEC-v3 — Atomic Markdown Memory

**Key principles from SPEC-v3:**

| Principle | Description |
|---|---|
| **One fact per file** | ไม่ผูกหลายเรื่องในไฟล์เดียว |
| **YAML frontmatter** | Metadata structured |
| **Generated views** | Auto-MOC from queries (Dataview-style) |
| **Linting** | Validate frontmatter / link integrity |
| **Inbox + Compactor** | Capture fast, organize later |
| **Append-only events** | Session logs ไม่แก้ย้อนหลัง |
| **Human-readable vs Agent-readable** | แยกไฟล์เพื่อคน vs เพื่อ agent |

→ **Adopted in this vault.** ดู [[AGENTS.md]] + [[Memory-Vault-Principles]].

### 5. Limits — ใช้กับอะไรบ้าง

> [!success] Sweet spot
> - **50–500 files**
> - Personal memory + project memory
> - Owner = ตัวเอง
> - Want tool-agnostic + portable

> [!warning] ไม่เหมาะกับ
> - 10,000+ ไฟล์ขององค์กร → ใช้ vector DB / Elasticsearch
> - Semantic search หนักๆ → ใช้ embedding + RAG
> - Multi-agent writing พร้อมกัน production-scale → ใช้ graph memory / DB

## Author's Starter Recipe

> [!tip] Start small, grow gradually
> 1. **CLAUDE.md + TASKS.md** ก่อน
> 2. แล้วเพิ่ม `memory/`
> 3. แล้วเพิ่ม `sources/`
> 4. แล้วทำ ingest, query, lint, log
>
> "ไม่ต้องทำทุกอย่างวันแรก"

## Distilled Insights → Linked

This source is the **primary inspiration** for:
- [[Memory-Vault-Principles]]
- [[AGENTS.md]] (3-layer architecture)
- [[MOC-Home]] (hub-and-spoke pattern)

## My Notes

> [!important] Most actionable quotes
> 1. "Convention is the new schema. Filesystem is the new index." → ใช้เป็น tagline ของ vault.
> 2. "อนาคตของ AI workflow อาจไม่ได้แข่งกันแค่ model ฉลาด แต่แข่งกันที่ใครออกแบบ memory + context + workflow ได้ดีกว่า" → ทักษะใหม่ของ dev.

> [!question] Open questions
> - Compactor → ทำเมื่อไหร่? (เลือก: monthly + manual trigger ใน [[Context-Rot-Prevention]])
> - Linting → tool อะไร? (TBD — อาจใช้ markdownlint + custom script ตรวจ frontmatter)
> - Append-only events → จะ enforce ยังไง? (ตอนนี้ใช้ convention เท่านั้น)

> [!todo] Adopted vs deferred
> - [x] One fact per file
> - [x] YAML frontmatter
> - [x] Inbox concept (ใน MOC-Home)
> - [x] CLAUDE.md / AGENTS.md analog
> - [ ] Generated views (รอ Dataview plugin)
> - [ ] Linting automation (manual ก่อน)

## Related Sources

- [[LeafBox-01-Memory-Vault]] — แนวคิดเริ่มต้น
- [[LeafBox-02-Claude-Code-Updates]] — Claude features ที่เชื่อมโยง (Dreams = compactor)
