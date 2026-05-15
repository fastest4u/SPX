---
title: Mistake-007 — Edit Without Verifying File Contents
type: mistake
severity: low
status: resolved
occurred-date: 2026-05-13
resolved-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-14
agent: cascade
area: topic/memory-vault
confidence: high
aliases:
  - Mistake-007
  - M-007
  - Blind Edit
tags:
  - mistake
  - project/spx
  - topic/memory-vault
  - severity/low
---

# Mistake-007 — Edit Without Verifying File Contents

> [!abstract] One-liner
> Attempted to edit `Awakened-AI-System.md` using an `old_string` that did not exist in the file, causing an edit failure. Did not read the relevant lines before attempting the replacement.

---

## What Happened

While updating `memory/00_Index/Awakened-AI-System.md` to add `/awaken` to the Awakening Stack table:

1. Assumed the file contained: `| **L4: Awakening** | Multi-perspective + self-checking | ...`
2. Tried to replace that exact string.
3. Edit tool reported: `Could not successfully apply any edits` — `old_string` not found.
4. Had to read the file again to discover the actual content.

---

## Root Cause

- Did not read the file (or read it long ago in the session) before editing.
- Assumed content based on memory of a similar file, not on actual file state.
- The file had slightly different formatting than expected.

---

## Correct Pattern

**Always read before editing:**

```text
1. Read the file (or relevant lines) immediately before the edit.
2. Copy the exact text you want to replace.
3. Paste it into old_string — do not retype or rely on memory.
4. If the file is large, read the specific line range first.
```

**If edit fails:**

```text
1. Read the file again.
2. Find the actual text.
3. Retry with exact match.
4. If still unsure, use multi_edit with a larger unique context string.
```

---

## Time Lost

~1 minute of retry and re-reading.

---

## How AI Should Avoid This

> [!tip] Pre-edit checklist
> 1. **Read the file** — use `read_file` on the exact path before any `edit` or `multi_edit`.
> 2. **Copy-paste exact text** — don't trust memory of what the file "probably" says.
> 3. **Verify uniqueness** — if `old_string` could appear multiple times, use a larger surrounding context.
> 4. **Handle edit failures gracefully** — if edit fails, re-read immediately rather than guessing.

---

## How To Detect Recurrence

- Edit tool returns `Could not successfully apply any edits`.
- `old_string` not found in file.
- Multiple edit attempts on the same file in quick succession.

---

## Related

- Session log: [[2026-05-13-Awaken-Slash-Command]]
- AGENTS.md rule: "Read before editing" (cited but not followed in this instance)
