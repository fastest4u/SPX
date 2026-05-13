<%*
const name = await tp.system.prompt("Component name");
const lang = await tp.system.suggester(
  ["TypeScript", "Python", "SQL", "JavaScript", "Other"],
  ["typescript", "python", "sql", "javascript", "other"],
  false,
  "Language?"
);
const status = await tp.system.suggester(
  ["Experimental", "Reusable", "Deprecated"],
  ["experimental", "reusable", "deprecated"],
  false,
  "Status?"
);
const area = await tp.system.prompt("Area tag (e.g. area/db, area/api)");
const project = await tp.system.prompt("Project tag (e.g. project/spx)");
await tp.file.rename(name);
await tp.file.move(`/03_Reusable_Components/${name}`);
-%>
---
title: <% name %>
type: component
status: <% status %>
language: <% lang %>
dependencies:
created: <% tp.date.now("YYYY-MM-DD") %>
updated: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - component
  - language/<% lang %>
  - <% area %>
  - <% project %>
---

# <% name %>

> [!abstract] Purpose
> One sentence: what does it do, when do you reach for it?

## When To Use

- Use when: ...
- Don't use when: ...

## Interface / API

```<% lang %>
// signature + 1-line docstring
```

## Example

```<% lang %>
// minimal working example
```

## How It Works

- Source: `path/to/file.<% lang === "typescript" ? "ts" : lang === "python" ? "py" : "ext" %>`
- Tests: `path/to/file.test.<% lang === "typescript" ? "ts" : lang === "python" ? "py" : "ext" %>`

## Gotchas

> [!warning] Known pitfalls
> - Gotcha 1

## Variants / Related

- [[Other component]] — similar but different in X way.

## History

- <% tp.date.now("YYYY-MM-DD") %> — Initial version.
