---
title: Plugin Setup Guide (Templater + Linter + Dataview)
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:memory/.obsidian/community-plugins.json + file:memory/.obsidian/plugins/obsidian-linter/data.json
confidence: high
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - reference
  - topic/tooling
aliases:
  - Plugin Configuration
  - Templater Setup
  - Linter Setup
---

# 🔌 Plugin Setup Guide

> [!abstract] Three plugins power this vault
> **Dataview** (query) + **Templater** (note creation) + **Linter** (manual linting only right now). This note tells future-you and future agents what is currently configured.

---

## 1. Dataview ✅ Already configured

> [!info] No setup needed
> Already enabled. See [[Dataview-Queries]] for usage.

---

## 2. Templater Setup

### Step 1 — Point Templater at `99_Templates/`

`Settings → Templater`:

| Setting | Value |
|---|---|
| **Template folder location** | `99_Templates` |
| **Trigger Templater on new file creation** | ✅ ON |
| **Folder template behavior** | (skip — using manual insert) |
| **Enable system commands** | ⚠️ ON only if you trust this vault |

### Step 2 — Hotkey for "Open Insert Template Modal"

`Settings → Hotkeys` → search **"Templater: Open insert template modal"** → set to `Ctrl+Shift+T` (or anything free).

### Step 3 — Test it

1. Create a new empty note (`Ctrl+N`).
2. Press `Ctrl+Shift+T` → pick **Template-Note**.
3. Templater will prompt for **title**, **topic tag**, **area tag**.
4. The note is renamed and filled automatically.

### Available templates (all Templater-enabled)

| Template | Prompts | Auto-moves to |
|---|---|---|
| `Template-Note` | title, topic, area | (current folder) |
| `Template-ADR` | ADR number, short title, project, area | `04_Architecture_Decisions/` |
| `Template-Session-Log` | topic, agent, project | `05_Agent_Session_Logs/` |
| `Template-Component` | name, language, status, area, project | `03_Reusable_Components/` |

### Templater syntax used

- `<% tp.date.now("YYYY-MM-DD") %>` — current date
- `<% tp.system.prompt("Question") %>` — text input
- `<% tp.system.suggester([labels], [values], false, "Question") %>` — dropdown
- `<%* await tp.file.rename(name) %>` — rename file
- `<%* await tp.file.move(path) %>` — move file

> [!tip] Reference
> [Templater Documentation](https://silentvoid13.github.io/Templater/) — comprehensive guide.

---

## 3. Linter Current State

Source checked: `memory/.obsidian/plugins/obsidian-linter/data.json`.

Current settings:

| Setting | Current value |
|---|---|
| `lintOnSave` | `false` |
| `yaml-timestamp.enabled` | `false` |
| `format-yaml-array.enabled` | `false` |
| `insert-yaml-attributes.enabled` | `false` |

> [!warning] Manual `updated:` rule
> Because Linter is installed but not auto-running, agents must update `updated: YYYY-MM-DD` manually when editing notes. This matches [[AGENTS]].

### Optional Future Change

If the human wants Obsidian to auto-update timestamps later:

1. Open Obsidian Settings -> Linter.
2. Enable `Lint on save`.
3. Enable `YAML timestamp`.
4. Set modified key to `updated`.
5. Re-check `memory/.obsidian/plugins/obsidian-linter/data.json`.
6. Update this note and [[AGENTS]] in the same commit.

---

## 4. Recommended Plugin Order

If installing fresh:

```mermaid
graph LR
    A[Dataview] --> B[Templater]
    B --> C[Linter]
    C --> D[Optional: Calendar, Tasks, Mind Map]
```

**Why this order?**

1. **Dataview** — read-only, no risk to existing notes.
2. **Templater** — affects new files only.
3. **Linter** — modifies files on save → install last so you understand current state first.

---

## 5. Quick Test Checklist

After installing all three, test like this:

- [ ] Open [[Vault-Dashboard]] → ตารางขึ้น = **Dataview OK**
- [ ] `Ctrl+N` → `Ctrl+Shift+T` → pick a template → prompts appear = **Templater OK**
- [ ] Edit any note → save → `updated:` field auto-bumps to today = **Linter OK**

---

## 6. Backup First!

> [!danger] Before enabling Linter on save
> Linter modifies files on save. Strongly consider:
> 1. Make a one-time backup of vault folder.
> 2. Test Linter rules on a single file first (`Lint the current file` command).
> 3. Only after happy → enable `Lint on save`.

---

## Related

- [[AGENTS]] — vault constitution (mentions plugins)
- [[Dataview-Queries]] — query reference
- [[Vault-Dashboard]] — uses Dataview live
- [[MOC-Home]] — navigation
