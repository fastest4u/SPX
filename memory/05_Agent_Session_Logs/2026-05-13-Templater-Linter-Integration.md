---
title: "2026-05-13 — Templater + Linter Integration"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 10
outcomes:
  - All 4 templates converted to Templater syntax
  - Plugin-Setup.md created with full configuration guide
  - AGENTS.md updated to teach next-agent about plugin stack
  - Linter timestamp config documented (auto-bumps updated field)
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - topic/tooling
  - topic/memory-vault
---

# 2026-05-13 — Templater + Linter Integration

> [!abstract] TL;DR
> User installed **Templater** and **Linter** plugins. Converted all 4 templates from `{{placeholder}}` style to **Templater syntax** with prompts + auto-rename + auto-move. Documented full config in [[Plugin-Setup]].

---

## Goal

Make note creation **interactive** (Templater) and frontmatter **self-maintaining** (Linter).

---

## What Was Done

### Templater conversion (4 templates)

- [x] `Template-Note` → prompts: title, topic tag, area tag → auto-rename
- [x] `Template-ADR` → prompts: number, short title, project, area → auto-rename + auto-move to `04_*`
- [x] `Template-Session-Log` → prompts: topic, agent (dropdown), project → auto-date + auto-move to `05_*`
- [x] `Template-Component` → prompts: name, language (dropdown), status (dropdown), area, project → auto-move to `03_*`

### Setup documentation

- [x] Created [[Plugin-Setup]] with:
    - Templater configuration steps (folder location, trigger, hotkey)
    - Linter YAML timestamp config (the killer feature)
    - Linter rules to **enable** + rules to **disable** (conflict avoidance)
    - Quick-test checklist for all 3 plugins
    - Backup warning before enabling Lint-on-save

### AGENTS.md updates

- [x] Replaced "Dataview is active" section with broader **"Plugin Stack"** subsection
- [x] Added **"Note Creation Workflow"** — teach agents to use `Ctrl+Shift+T` instead of `obsidian_write_note` for new notes
- [x] Added **"Linter Auto-Updates"** — tell agents to stop manually bumping `updated:`
- [x] Linked [[Plugin-Setup]] in Related section

---

## Files Touched

| File | Change |
|---|---|
| `99_Templates/Template-Note.md` | Rewrite — Templater prompts |
| `99_Templates/Template-ADR.md` | Rewrite — Templater + auto-move |
| `99_Templates/Template-Session-Log.md` | Rewrite — Templater + agent suggester |
| `99_Templates/Template-Component.md` | Rewrite — Templater + lang/status suggesters |
| `00_Index/Plugin-Setup.md` | Created |
| `AGENTS.md` | Patched — Plugin Stack section + Linter rule for next-agent |

---

## Decisions Made

- **Templater over Obsidian native templates** — supports prompts, file rename, file move. Native templates only do string substitution.
- **Linter auto-bumps `updated:`** — frees humans + agents from manual maintenance. Field is now **reliable**, queryable via Dataview.
- **Auto-move on template insert** — eliminates the "I forgot to put it in the right folder" failure mode.
- **AGENTS.md teaches the workflow** — next agent knows to use `Ctrl+Shift+T` instead of writing a raw note via API. Self-perpetuating convention.

---

## Insights / Learnings

> [!tip] Worth promoting to insights — yes
> **"Schema enforcement is multi-layered":**
> 1. AGENTS.md = manual rules
> 2. Templates = scaffolding correct shape
> 3. Templater prompts = forced compliance on creation
> 4. Linter = forced compliance on every save
> 5. Dataview queries = visibility into compliance (orphans, missing fields)
>
> Each layer catches what the previous missed. Defense-in-depth for vault hygiene.

> [!example] Workflow change for agents
> **Before:** Agent calls `obsidian_write_note` with hand-crafted frontmatter → easy to forget fields.
> **After:** Agent suggests user to use Templater for new notes → frontmatter is **guaranteed correct**.
>
> Exception: bulk imports or programmatic generation still use direct API.

---

## Open Issues / Follow-ups

- [ ] Test each template manually (`Ctrl+Shift+T` → pick → fill prompts) — confirm renames + moves work.
- [ ] Confirm Linter YAML timestamp is configured correctly (check `Settings → Linter → YAML timestamp`).
- [ ] Backup vault before enabling **Lint on save** (per warning in [[Plugin-Setup#6]]).
- [ ] Consider promoting the "defense-in-depth" insight to `07_Insights/Schema-Enforcement-Layers.md` (if pattern recurs).

---

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] All 4 templates use Templater syntax (prompts + auto-actions)
> - [x] [[Plugin-Setup]] covers all 3 plugins (Dataview already + Templater + Linter)
> - [x] [[AGENTS]] teaches next-agent to use Templater workflow
> - [x] [[AGENTS]] tells next-agent Linter auto-bumps `updated:` (don't waste tokens)
> - [x] Session log written (this file)
> - [x] All new wikilinks resolve (no broken links)

---

## References

- Previous session: [[2026-05-13-Dataview-Integration]]
- Plugin docs: [Templater](https://silentvoid13.github.io/Templater/) · [Linter](https://platers.github.io/obsidian-linter/) · [Dataview](https://blacksmithgu.github.io/obsidian-dataview/)
- Related: [[Plugin-Setup]], [[AGENTS]], [[Memory-Vault-Principles]]
