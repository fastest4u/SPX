---
title: "LeafBox Digest — AI Agent ที่ไม่มี Memory Vault = Dev เก่งแต่ความจำสั้น"
type: source
source-author: LeafBox Digest (นิว)
source-url: 
source-date: "2026-05-01"
ingested-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
tags:
  - source
  - topic/memory-vault
  - topic/obsidian
  - language/thai
aliases:
  - Memory Vault Article
---

# LeafBox-01 — AI Agent ที่ไม่มี Memory Vault = Dev เก่งแต่ความจำสั้น

> [!abstract] Core thesis
> ปัญหาของ AI coding agents ไม่ใช่ความเก่ง แต่คือ **"ไม่มีความจำระยะยาว"** — ต้องอธิบาย context เดิมซ้ำๆ ทุก session. Obsidian ใช้เป็น **Memory Vault** ได้ดีเพราะเป็น plain Markdown.

## Source Info

- **Author:** LeafBox Digest (นิว)
- **Reference inspiration:** บทความจาก Geeky Gadgets
- **Topic:** Obsidian as Memory Vault for AI coding agents (Claude Code, Codex)

## Verbatim Key Quotes

> "AI agent ที่มี memory ดี จะไม่ได้แค่ทำงานเร็วขึ้น แต่มันจะเริ่มเข้าใจ project DNA ของเรามากขึ้นเรื่อย ๆ"

> "ต่อไป developer ที่ใช้ AI เก่ง อาจไม่ใช่คนที่ prompt เก่งที่สุด แต่อาจเป็นคนที่ 'จัดความรู้ให้ AI ใช้ซ้ำได้ดีที่สุด'"

> "Game จริงไม่ใช่ใครใส่ context ได้เยอะสุด แต่คือใครดึง context ที่ถูกต้อง ในเวลาที่ถูกต้อง ได้ดีที่สุด" — *(referencing Cloudflare on Agent Memory)*

## 5 Key Points (Original Structure)

### 1. Memory Vault ช่วยลดการอธิบายซ้ำ

AI agent เริ่ม session ใหม่ทุกครั้ง → ต้องอธิบาย project context, debug history, team patterns ใหม่หมด.

> Onboarding document ที่ไม่ได้มีไว้ให้คนอ่านอย่างเดียว แต่มีไว้ให้ AI อ่านด้วย.

### 2. Obsidian + Markdown คือ format ที่ AI ชอบมาก

- Plain Markdown → ไม่ lock-in
- Folder structure ตั้งต้น: `Project Rules`, `API Notes`, `Components`, `Architecture Decisions`, `Debug Logs`, `Prompt Templates`, `Agent Sessions`
- Human-readable + AI-readable + version-controllable

### 3. Dataview ทำให้ vault ไม่ใช่แค่กอง note

- Plugin **Dataview** query metadata (tags, YAML, inline fields) → vault กลายเป็น "database แบบมนุษย์อ่านรู้เรื่อง"
- ตัวอย่าง: tag `status: reusable` หรือ `api: billing` → ดึงรายการออกมาได้

### 4. Claude Code มี memory แต่ Obsidian เติมเต็มอีกชั้น

| Layer | Purpose |
|---|---|
| `CLAUDE.md` | กฎสำคัญของโปรเจกต์ |
| Claude auto memory | สิ่งที่ agent เรียนรู้เอง |
| **Obsidian vault** | knowledge base ที่คน + AI ใช้ร่วมกัน |

### 5. ระวัง! อย่าให้ vault กลายเป็น "สุสาน note"

- ไม่มี structure / tag / template / naming convention → กลายเป็น "กองเอกสารที่ AI ไม่อยากอ่าน"
- อ้างอิง **Cloudflare on Agent Memory**: context window ใหญ่ขึ้น ≠ ดีขึ้น (context rot)

## Recommended Starter Structure (5 folders)

```
01_Project_Rules
02_API_Docs
03_Reusable_Components
04_Architecture_Decisions
05_Agent_Session_Logs
```

→ Adopted as the base of this vault. See [[AGENTS.md#Folder Conventions]].

## Distilled Insights → Linked

This source contributes to:
- [[Memory-Vault-Principles]]
- [[Context-Rot-Prevention]]
- [[AGENTS.md]] (folder structure)

## My Notes

> [!question] What's missing?
> บทความนี้พูดถึง "structure" แต่ไม่ได้บอกชัดว่าจะ **maintain** ยังไงไม่ให้รก → ดู [[Context-Rot-Prevention]] เพิ่ม.

> [!tip] Action items extracted
> 1. สร้าง folder structure ตามที่แนะนำ ✅ done
> 2. ตั้ง naming convention ✅ done (ใน [[AGENTS.md]])
> 3. เพิ่ม Dataview plugin → *พิจารณาภายหลัง*
> 4. เริ่มทำ session logs ✅ ([[2026-05-13-Setup-MCP-Servers]])

## Related Sources

- [[LeafBox-02-Claude-Code-Updates]] — Claude features ที่ใช้คู่กัน
- [[LeafBox-03-Obsidian-Memory-for-AI]] — โครงสร้าง 3-layer ที่ลึกกว่า
