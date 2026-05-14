---
title: Source-Grounded Documentation
type: insight
status: stable
derived-from:
  - [[2026-05-13-System-Survey-Awakened-AI-Update]]
  - [[2026-05-13-Vault-Hardening-Pass-3]]
confidence: high
created: 2026-05-13
updated: 2026-05-13
tags:
  - insight
  - project/spx
  - topic/docs
  - topic/quality
aliases:
  - Grounded Docs
  - Code-Grounded Memory
---

# Source-Grounded Documentation

> [!abstract] Insight
> Documentation written after reading the source file is provably more accurate than documentation written from memory or generic templates. Every claim should cite a file path, line range, or symbol name.

---

## The Problem

Generic documentation promises but does not prove:

| Pattern | Risk |
|---|---|
| "The API returns 409 on duplicate" | Provider may change behavior; no evidence |
| "Retry 3 times with backoff" | `MAX_RETRIES` may be 5 in code; drift |
| "Settings require restart" | Current implementation uses live reload |

Stale documentation is worse than no documentation because it creates false confidence.

---

## The Pattern

Before writing a note, read the source. After writing, cite the source.

```markdown
## Implementation

Grounded in `src/services/api-client.ts:14-54`.

- `fetchWithRetry` signature:
- Retryable statuses: `408`, `425`, `429`, `5xx`
- Backoff schedule: 1s → 2s → 4s + jitter
```

Required frontmatter for source-grounded notes:

```yaml
source: file:src/services/api-client.ts
last-verified: 2026-05-13
verified-by: codex
confidence: high
```

---

## Examples from SPX

| Note | Source File | What It Proves |
|---|---|---|
| [[API-Bidding-Endpoints]] | `src/services/api-client.ts` | All 4 endpoints, retcodes, headers |
| [[Component-Retry-With-Backoff]] | `src/services/api-client.ts:14-54` | Exact retry constants, caller mapping |
| [[SPX-System-Map]] | `src/app.ts`, `src/controllers/poller.ts` | Boot sequence, poller orchestration |
| [[ADR-002-DB-Backed-Live-Settings]] | `src/controllers/settings-controller.ts` | Live reload, no process restart |

---

## Verification Rule

When code changes:

1. Re-read the cited source file.
2. Update the note if constants, signatures, or behavior changed.
3. Bump `last-verified` and `verified-by`.
4. If the change is architectural → create or update an ADR.

---

## Anti-Patterns

> [!failure] Don't
> - ❌ Write docs from memory without opening the source file.
> - ❌ Use approximate values ("around 3 retries") when the code has exact constants.
> - ❌ Skip `source:` frontmatter because "everyone knows where it is."
> - ❌ Copy API responses verbatim into notes — summarize and cite.

---

## Related

- [[Defense-In-Depth-Vault-Architecture]]
- [[Mistake-002-Stale-Memory-Docs-Overrode-Source]]
- [[Runbook-Production-Schema-Verification]]
