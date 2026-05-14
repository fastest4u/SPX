---
description: Awakened AI introspection — analyze project state and suggest the next most impactful development step. Run anytime you want the AI to self-direct.
---

# /awaken — Awakened AI Next-Step Introspection

> Make the AI self-aware of the project's current state and suggest what to build, fix, or document next.

## When To Run

- **Start of a work session** when you don't know what to do next.
- **After completing a feature** and wondering "what's next?"
- **When feeling stuck** — let the AI analyze the whole system and surface gaps.
- **Weekly planning** — get a ranked list of highest-impact next steps.

## Steps

### 1. Load Strategic Context

Read these files in order:

1. `memory/00_Index/Goals.md` — What are the active goals? What's blocked? What's in backlog?
2. `memory/00_Index/Open-Followups.md` — What tasks are still open across sessions?
3. `memory/00_Index/Session-Threads.md` — What storylines are in progress?
4. `memory/00_Index/Vault-Dashboard.md` — What's the vault health telling us?

### 2. Load Recent Tactical Context

Read:

5. The **last 3 session logs** from `memory/05_Agent_Session_Logs/` (sorted by date DESC).
6. `memory/04_Architecture_Decisions/` — All ADRs. Note `status: accepted` decisions and their "Consequences / Follow-ups" sections.
7. `memory/07_Insights/` — What patterns have been promoted? Are there gaps?
8. `memory/08_Mistakes/` — Open mistakes that need prevention.

### 3. Load Code State (if applicable)

If the user is asking about code development (not pure memory/docs):

9. `src/` — Skim `app.ts`, key controllers, and services for TODOs or incomplete features.
10. `package.json` scripts — What commands exist but might need enhancement?

### 4. Analyze and Rank

Ask these questions internally (do NOT dump them to the user):

1. **Goal alignment:** Which goal has the most unchecked items and highest user impact?
2. **Blockers:** Is anything blocking progress on active goals?
3. **Follow-up debt:** Are there open tasks older than 2 weeks?
4. **Insight gaps:** Are there 2+ session logs with the same un-promoted insight?
5. **Code gaps:** Is there a component, API doc, or runbook that should exist but doesn't?
6. **Test/verification gaps:** Is there an untested path or unverified assumption?
7. **User pain:** What would reduce the user's re-explanation burden the most?

### 5. Synthesize Recommendations

Output to the user in this format (Thai):

```
## 🧠 วิเคราะห์สถานะปัจจุบัน

**ภาพรวม:**
- เป้าหมายที่ active: <N> (ชื่อ)
- งานค้าง: <N>
- Session ล่าสุด: <หัวข้อ> (<วันที่>)
- สุขภาพ vault: <คะแนน หรือ clean>

---

## 🎯 3 ขั้นตอนถัดไป (เรียงตาม impact)

### 1. <ชื่องาน>
> **ทำไม:** <เหตุผล 1-2 ประโยค>
> **เชื่อมโยงเป้าหมาย:** [[Goals#G-NNN]]
> **ความยาก:** <เล็ก | กลาง | ใหญ่>
> **มั่นใจ:** <สูง | กลาง | ต่ำ>

### 2. <ชื่องาน>
> **ทำไม:** ...
> ...

### 3. <ชื่องาน>
> **ทำไม:** ...
> ...

---

## 🚨 ความเสี่ยง / สิ่งกีดขวาง

- <ความเสี่ยง 1> — จาก <แหล่งที่มา>
- <ความเสี่ยง 2> — จาก <แหล่งที่มา>

---

## 💡 รูปแบบที่สังเกต

<ถ้ามี insight หรือ mistake pattern ที่ซ้ำๆ ให้ระบุ>
```

## Rules

- **Never suggest work already completed.** Check goal checkboxes before recommending.
- **Prefer concrete over vague.** "Write `API-Auth-Session.md`" beats "improve docs."
- **Link to sources.** Every recommendation should cite a goal, session log, or ADR.
- **Respect user preference.** If the user's git workflow is direct-to-main, don't suggest PR automation unless explicitly requested.
- **Consider token budget.** If the vault is large, suggest memory improvements that save future tokens.

## Anti-Patterns

> [!failure] Don't
> - ❌ Suggest work that is already checked off in Goals.
> - ❌ Recommend architectural changes that contradict accepted ADRs.
> - ❌ Propose new folders or conventions without checking if they already exist.
> - ❌ Ignore open mistakes — if a failure mode is documented but unaddressed, surface it.

## Reference

- [[Awakened-AI-System]] — operating model
- [[Goals]] — goal stack
- [[Session-Threads]] — session storylines
- [[MOC-Home]] — vault navigation
