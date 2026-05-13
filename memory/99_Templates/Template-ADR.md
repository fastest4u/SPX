<%*
const adrNum = await tp.system.prompt("ADR number (3-digit, e.g. 002)");
const shortTitle = await tp.system.prompt("Short title (kebab-case)");
const project = await tp.system.prompt("Project tag (e.g. project/spx)");
const area = await tp.system.prompt("Area tag (e.g. area/db)");
const filename = `ADR-${adrNum}-${shortTitle}`;
await tp.file.rename(filename);
await tp.file.move(`/04_Architecture_Decisions/${filename}`);
-%>
---
title: ADR-<% adrNum %> — <% shortTitle.replace(/-/g, " ") %>
type: adr
status: proposed
decision-date: <% tp.date.now("YYYY-MM-DD") %>
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
supersedes:
superseded-by:
tags:
  - adr
  - <% project %>
  - <% area %>
---

# ADR-<% adrNum %> — <% shortTitle.replace(/-/g, " ") %>

> [!abstract] Status
> **proposed** | accepted | deprecated | superseded
> *Decided on: <% tp.date.now("YYYY-MM-DD") %>*

## Context

What is the problem? What forces are at play? Why are we deciding now?

Write 1–3 paragraphs. No solutions yet — just frame the problem.

## Decision

**We will {{verb}} {{noun}}.**

Justification:
- Reason 1
- Reason 2

## Alternatives Considered

### Option A — {{name}}

- Pros: ...
- Cons: ...
- Rejected because: ...

### Option B — {{name}}

- Pros: ...
- Cons: ...
- Rejected because: ...

## Consequences

> [!success] Positive
> - ...

> [!warning] Negative / Trade-offs
> - ...

> [!info] Neutral / Follow-ups
> - ...

## References

- [[Related note]]
- External: [link](https://...)

## Related ADRs

- *(none yet)*
