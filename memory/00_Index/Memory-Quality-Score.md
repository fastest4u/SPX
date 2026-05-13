---
title: Memory Quality Score
type: reference
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:scripts/memory-score.mjs
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Memory Score
  - Vault Quality Score
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/verification
---

# Memory Quality Score

> [!abstract] Purpose
> `npm run memory:score` summarizes Memory Vault quality as a deterministic score and a set of maintenance signals.

---

## Command

Run from repo root:

```bash
npm run memory:score
```

For a minimum score gate:

```bash
node scripts/memory-score.mjs --min=80
```

The default command is informational and exits 0. The `--min=` mode exits non-zero only when the score is below the requested threshold.

---

## Metrics

The score currently tracks:

- Total Markdown files and notes by `type`.
- Files with valid frontmatter.
- Broken wikilinks.
- Notes with `updated:` older than 90 days.
- Notes with `last-verified:` older than 90 days.
- Source-candidate notes missing `source`, `last-verified`, `verified-by`, or `confidence`.
- Open mistake entries.
- Unchecked follow-up tasks in session logs.
- Multi-AI acceptance pass/pending/fail counts from [[Multi-AI-Acceptance-Results]].

---

## Score Meaning

| Score | Meaning |
|---|---|
| 95-100 | Excellent. Memory is source-grounded and low-maintenance. |
| 85-94 | Good. Some pending follow-ups or source fields need cleanup. |
| 75-84 | Usable but needs maintenance before major production work. |
| 60-74 | Risky. Re-read source files before trusting memory. |
| Below 60 | Do not rely on memory without a cleanup pass. |

---

## Maintenance Pattern

Use this after memory-heavy sessions:

```bash
npm run memory:verify
```

`memory:verify` runs `memory:check`, `memory:eval`, and `memory:score`.

Use this after code + memory changes:

```bash
npm run verify
```

---

## Related

- [[Vault-Dashboard]]
- [[Memory-Evaluation-Test]]
- [[Multi-AI-Acceptance-Results]]
- [[Awakened-AI-System]]
