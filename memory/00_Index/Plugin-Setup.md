---
title: Plugin Setup Guide (Templater + Linter + Dataview)
type: reference
status: active
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
> **Dataview** (query) + **Templater** (note creation) + **Linter** (auto-fix on save). This note tells future-you (and future agents) exactly how to configure them.

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

## 3. Linter Setup

### Step 1 — Enable the right rules

`Settings → Linter → Lint on save`: ✅ ON

Then enable these rule groups:

#### YAML rules (most important)

| Rule | Setting |
|---|---|
| **Format YAML array** | enabled |
| **Insert YAML attributes** | enabled — pre-populate `title`, `created`, `updated`, `tags` |
| **YAML title** | enabled (use heading as title) |
| **YAML title alias** | optional |
| **YAML timestamp** | ✅ enabled (this is the killer feature) |

#### YAML timestamp config

| Sub-setting | Value |
|---|---|
| **Date Created** | ✅ ON |
| **Date Created Key** | `created` |
| **Date Modified** | ✅ ON |
| **Date Modified Key** | `updated` |
| **Format** | `YYYY-MM-DD` |
| **Force retention of date created** | ✅ ON |

> [!success] Result
> Every save automatically refreshes the `updated:` field. **Manual updates are no longer needed** — Linter handles it.

#### Heading rules

| Rule | Setting |
|---|---|
| **Header increment** | enabled |
| **File name heading** | enabled (auto-add `# Title` if missing) |
| **Capitalize headings** | disabled (we use mixed case intentionally) |

#### Footnote / Spacing rules

| Rule | Setting |
|---|---|
| **Remove trailing whitespace** | enabled |
| **Remove multiple spaces** | enabled |
| **Two spaces between sentences** | disabled |
| **Empty line around tables / code blocks** | enabled |

#### Content rules

| Rule | Setting |
|---|---|
| **Remove consecutive list markers** | enabled |
| **Trailing newlines** | enabled (force exactly one) |
| **Compact YAML** | disabled (we prefer expanded) |

### Step 2 — Disable conflict-prone rules

> [!warning] Turn OFF these (they fight with our convention)
> - **Re-Index Footnotes** — we don't use footnotes
> - **Convert Bullet List Markers** — keep `-` style
> - **Auto-correct common misspellings** — false positives on tech terms
> - **Move math blocks below tags** — irrelevant here

### Step 3 — Custom regex (optional, advanced)

If you want **strict frontmatter enforcement**, add a Custom Regex rule:

```regex
Find: ^(?!---\n).*\n# 
Flags: m
Replace: (intentionally empty — flags missing frontmatter)
```

(This is a starting point — Linter has a Custom Regex section but limited; for strict enforcement consider [obsidian-linter-action](https://github.com/platers/obsidian-linter) CI later.)

### Step 4 — Hotkey

`Settings → Hotkeys` → search **"Linter: Lint the current file"** → bind to `Ctrl+Alt+L`.

> [!info] Reference
> [Obsidian Linter Documentation](https://platers.github.io/obsidian-linter/) — full rule catalogue.

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
