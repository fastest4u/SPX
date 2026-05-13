<%*
const title = await tp.system.prompt("Note title");
const topic = await tp.system.prompt("Primary tag (e.g. project/spx, topic/memory-vault)");
const area  = await tp.system.prompt("Area tag (e.g. area/db, area/api) — optional", "");
await tp.file.rename(title);
-%>
---
title: <% title %>
type: note
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - <% topic %><% area ? "\n  - " + area : "" %>
aliases:
---

# <% title %>

> [!abstract] TL;DR
> One-sentence summary of what this note is about.

## Context

What problem / situation does this note address?

## Key Points

- Point 1.
- Point 2.

## Details

Body of the note. Use callouts where they add value:

> [!tip] Pro tip
> ...

> [!warning] Gotcha
> ...

## Related

- [[Other note]]

## Open Questions

- [ ] Question 1
- [ ] Question 2
