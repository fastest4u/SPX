---
description: Run a metacognitive self-check before risky work
---

# /self-check — AI Self-Reflection

## Steps

1. State the task in one sentence.
2. Check confidence honestly and cite evidence.
3. Read `memory/08_Mistakes/` for related mistakes.
4. Read `memory/AGENT-IDENTITY.md` for role and limits.
5. Read `memory/00_Index/Goals.md` for goal alignment.
6. Check recent session logs for prior work.
7. Output the self-check report.

## Output

Use this format:

```text
## 🪞 Self-Check

**Task:** <one sentence>
**Confidence:** <level> — <why>
**Past mistakes to avoid:**
- <mistake>
**Identity alignment:** ✅ / ⚠️ / ❌
**Goal:** advances <goal>
**Prior work:** <session>

Proceeding unless you raise a concern.
```
