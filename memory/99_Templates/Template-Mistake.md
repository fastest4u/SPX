<%*
const num = await tp.system.prompt("Mistake number (3-digit, e.g. 002)");
const shortTitle = await tp.system.prompt("Short title (kebab-case, e.g. Forgot-Js-Suffix-Import)");
const severity = await tp.system.suggester(
  ["Low (annoying)", "Medium (10+ min lost)", "High (broke something)", "Critical (data/prod impact)"],
  ["low", "medium", "high", "critical"],
  false,
  "Severity?"
);
const agent = await tp.system.suggester(
  ["Cascade", "Claude Code", "Codex", "Cursor", "Human", "Other"],
  ["cascade", "claude", "codex", "cursor", "human", "other"],
  false,
  "Who made the mistake?"
);
const area = await tp.system.prompt("Area (e.g. tooling/mcp, area/db, language/typescript)");
const project = await tp.system.prompt("Project tag (e.g. project/spx)");
const filename = `Mistake-${num}-${shortTitle}`;
await tp.file.rename(filename);
await tp.file.move(`/08_Mistakes/${filename}`);
-%>
---
title: Mistake-<% num %> — <% shortTitle.replace(/-/g, " ") %>
type: mistake
severity: <% severity %>
status: open
occurred-date: <% tp.date.now("YYYY-MM-DD") %>
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
agent: <% agent %>
area: <% area %>
confidence: high
tags:
  - mistake
  - <% project %>
  - severity/<% severity %>
---

# Mistake-<% num %> — <% shortTitle.replace(/-/g, " ") %>

> [!abstract] One-liner
> Brief description of what went wrong in one sentence.

## What Happened

Step-by-step what was attempted.

## Root Cause

Why it failed — get to the *actual* reason.

## Correct Pattern

```
// Show the right way
```

**NOT this:**

```
// Show the wrong way (what was attempted)
```

## Time Lost

~XX minutes.

## How AI Should Avoid This

> [!tip] Pre-flight checklist
> 1. Step 1
> 2. Step 2

## How To Detect Recurrence

Symptoms that indicate the same mistake is being repeated:

- Symptom 1
- Symptom 2

## Related

- ADR affected: [[ADR-NNN-...]] *(if any)*
- Session log: [[YYYY-MM-DD-...]]
- Similar mistakes: [[Mistake-NNN-...]]
