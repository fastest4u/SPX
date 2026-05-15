---
title: Component - Dual Storage Notify Rules
type: component
language: typescript
status: reusable
dependencies: []
last-verified: 2026-05-13
verified-by: codex
source: file:src/services/notify-rules.ts + file:src/repositories/auto-accept-repository.ts + file:src/db/schema.ts
confidence: high
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Dual Storage Rules
  - Notify Rules Storage
  - Rules Engine Storage
tags:
  - component
  - project/spx
  - language/typescript
  - area/db
  - area/notify
  - topic/rules
---

# Component - Dual Storage Notify Rules

> [!abstract] Purpose
> `notify-rules.ts` supports local JSON rules in development and MySQL-backed rules in production, while exposing the same async API to the rest of the app.
> Current runtime policy: enabled rules are auto-accept candidates; rule-match-only notifications are disabled.

---

## When To Use

Read this before:

- Changing rule persistence.
- Adding fields to rule shape.
- Debugging why a rule exists in JSON but not DB.
- Extending auto-accept progress fields.
- Editing migration/runtime DB schema for `notify_rules`.

---

## Public API

Source: `src/services/notify-rules.ts`

Key exported operations:

```typescript
readRules(): Promise<NotifyRule[]>
createRule(input): Promise<NotifyRule>
updateRule(id, patch): Promise<NotifyRule | null>
deleteRule(id): Promise<NotifyRule | null>
matchRules(trips): Promise<MatchedRule[]>
getActiveAutoAcceptRules(): Promise<NotifyRule[]>
markRuleAutoAccepted(id): Promise<void>
migrateJsonToDb(): Promise<void>
```

All functions are async, even when JSON storage is used.

---

## Storage Selection

```text
usesDb =
  NODE_ENV === "production"
  AND (SAVE_TO_DB OR HTTP_ENABLED OR AUTO_ACCEPT_ENABLED)
```

| Environment | Storage |
|---|---|
| Development or no DB feature flags | `notify-rules.json` |
| Production with DB-backed feature flags | `notify_rules` MySQL table |

The root JSON file is ignored by git and is local runtime state.

---

## Rule Shape

```typescript
type NotifyRule = {
  id: string;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
  auto_accept: boolean;
  auto_accepted: boolean;
};
```

`auto_accept` remains in the shape for schema/API compatibility, but enabled rules are normalized and evaluated as auto-accept rules. The UI no longer exposes a separate "notify only" mode.

DB serialization:

- Arrays are JSON-stringified into `VARCHAR(4000)`.
- Booleans are stored as integer `0` or `1`.
- `id` is stable and generated from a SHA1 fingerprint when not supplied.

---

## Migration Behavior

`migrateJsonToDb()`:

1. Runs only when DB storage is active.
2. Reads local JSON rules.
3. Checks if DB already has rules.
4. If DB is empty, inserts JSON rules.
5. If DB has rules, leaves DB as source of truth.

This prevents local JSON from overwriting production rule state after first migration.

See [[ADR-001-Dual-Storage-Notify-Rules]].

---

## Broadcast Behavior

Rule create/update/delete and progress updates broadcast SSE `rules` events through `sseBroadcaster`.

Why this matters:

- Dashboard rule list updates without manual refresh.
- Auto-accept progress can appear live.
- Any new rule state field must be compatible with frontend `NotifyRule` type.

See [[API-SSE-Events]].

---

## Gotchas

- If `NODE_ENV` is not `production`, the app may use JSON even if DB env vars exist.
- JSON write fallback exists for Docker overlay file-lock behavior.
- Changing rule fields requires updates in:
  - `src/services/notify-rules.ts`
  - `src/db/schema.ts`
  - `src/db/migration-sql.ts`
  - `src/db/client.ts`
  - `src/db/client-memory.ts`
  - `src/frontend/types/index.ts`
  - `src/frontend/components/*RuleDialog*.tsx`
  - Memory docs and possibly [[API-Internal-HTTP]]
- Existing production migrations are filename-tracked; changing an already-applied SQL file will not alter an existing DB.

---

## Related

- [[ADR-001-Dual-Storage-Notify-Rules]]
- [[SPX-System-Map]]
- [[Component-Poller-Orchestration]]
- [[Runbook-Auto-Accept-Debug]]
- [[Runbook-DB-Migration]]
