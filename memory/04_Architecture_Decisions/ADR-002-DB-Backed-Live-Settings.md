---
title: ADR-002 - DB-Backed Live Settings
type: adr
status: accepted
decision-date: 2026-05-13
confidence: high
created: 2026-05-13
updated: 2026-05-13
supersedes:
superseded-by:
tags:
  - adr
  - project/spx
  - area/config
  - area/db
---

# ADR-002 - DB-Backed Live Settings

> [!abstract] Status
> Accepted on 2026-05-13. This ADR records the current implementation observed in `src/controllers/settings-controller.ts` and `src/services/settings.ts`.

---

## Context

The dashboard needs to update selected runtime settings such as `API_URL`, `COOKIE`, `DEVICE_ID`, notification targets, poll interval, and detail concurrency.

The earlier documented model said the UI persisted settings by rewriting `.env` and restarting the process. The current implementation stores selected settings in the `app_settings` table and applies them to the mutable runtime `env` object through `reloadSettingsLive()`.

For SPX this matters because settings include secrets, operator recovery data, and live poller behavior. A stale memory claim here can cause an AI to recommend the wrong recovery action.

---

## Decision

We will treat `app_settings` as the source of truth for dashboard-managed runtime settings when the database is usable.

Implementation:

- `migrateEnvSettingsToDb()` copies selected env values into `app_settings` if DB rows are missing.
- `loadDbSettingsIntoEnv()` loads DB settings into runtime env during boot.
- `SettingsController` redacts secrets on read.
- `SettingsController` preserves masked secret values on write.
- `writeSettings()` upserts DB rows and updates runtime env.
- `reloadSettingsLive()` reloads DB settings into the mutable `env` object.

---

## Alternatives Considered

### Rewrite `.env` and restart process

Pros:

- Easy mental model.
- Persists through process restart without DB dependency.

Cons:

- Writes secrets to a local file from the UI path.
- Requires restart to apply settings.
- Can conflict with container-managed env.
- Was stale relative to the current implementation.

Rejected because live DB-backed settings are already implemented and safer for dashboard operation.

### Keep env-only config

Pros:

- Simple deployment model.
- No settings table.

Cons:

- Operators cannot update session cookie or notification targets from the dashboard.
- Slower recovery from upstream session expiry.

Rejected because the Web UI is an operator surface.

---

## Consequences

> [!success] Positive
> - Settings can apply live without process restart.
> - Secrets are redacted in API responses.
> - Masked secret values do not overwrite real stored values.
> - Operator recovery from session expiry is faster.

> [!warning] Trade-offs
> - `app_settings` must exist and be included in migrations/runtime table creation.
> - Runtime env is mutable, so source-reading agents must inspect `src/services/settings.ts` before assuming static env behavior.
> - Settings written in DB can differ from root `.env`.

> [!info] Follow-ups
> - Keep [[SPX-Project-Rules]], [[SPX-System-Map]], and root `AGENTS.md` aligned with this ADR.
> - Include settings behavior in [[Memory-Evaluation-Test]].

---

## Verification

Source files:

- `src/controllers/settings-controller.ts`
- `src/services/settings.ts`
- `src/app.ts`
- `src/db/schema.ts`

Local checks:

```bash
npm run memory:check
npm run memory:eval
npm run build
```

---

## Related

- [[SPX-System-Map]]
- [[SPX-Project-Rules]]
- [[API-Internal-HTTP]]
- [[Runbook-API-Session-Expired]]
