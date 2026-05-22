---
title: ADR-001 — Dual-Mode Storage for Notify Rules (JSON in DEV, MySQL in PROD)
type: adr
status: accepted
decision-date: 2026-04-25
confidence: high
created: 2026-05-13
updated: 2026-05-13
supersedes: 
superseded-by: 
tags:
  - adr
  - project/spx
  - area/db
  - area/notify
---

# ADR-001 — Dual-Mode Storage for Notify Rules

> [!abstract] Status
> **accepted** — *Decided on: 2026-04-25*

## Context

SPX poller needs **rules** that match incoming bidding requests against user-defined criteria (origins, destinations, vehicle types). Rules drive:

1. Notifications (Discord embeds, LINE messages).
2. Auto-accept of matching requests.

**Requirements:**

- Rules must persist across restarts.
- Rules must be editable via Web UI (Fastify + RBAC + JWT).
- Development should not require MySQL setup.
- Production needs concurrent access (server + Web UI), SSE broadcast, atomicity.
- Multiple environments (local dev, CI, Docker prod).

**Forces:**

- Dev convenience: avoid MySQL dependency for local-only testing.
- Prod robustness: MySQL transactions + concurrent reads/writes.
- Schema parity: same logical model in both modes (no code duplication).
- Migration path: existing users have `notify-rules.json`; can't break them.

---

## Decision

**We will use dual-mode storage with environment-based switching:**

| Mode | Storage | Trigger |
|---|---|---|
| **DEV** | `notify-rules.json` at project root | `NODE_ENV !== "production"` OR no DB flags set |
| **PROD** | `notify_rules` MySQL table | `NODE_ENV === "production"` + DB env vars set |

**JSON file in PROD is used only for one-time migration on first startup.**

Both modes implement the same async API (`getRules()`, `addRule()`, `updateRule()`, `deleteRule()`).

---

## Alternatives Considered

### Option A — JSON Always (KISS)

- ✅ Pros: zero infrastructure, easy to inspect
- ❌ Cons:
    - File locks on Docker overlay FS (EBUSY errors observed)
    - No concurrent writes
    - No transactions for rule + history together
    - Web UI + poller writing simultaneously = race
- **Rejected because:** Doesn't survive production load.

### Option B — MySQL Always

- ✅ Pros: production-grade, transactions, concurrent-safe
- ❌ Cons:
    - Local dev requires running MySQL
    - CI needs MySQL service
    - Slower iteration cycle
- **Rejected because:** Friction is too high for solo dev workflow.

### Option C — SQLite for Both

- ✅ Pros: single file, no server, transactions
- ❌ Cons:
    - Different SQL dialect from prod MySQL
    - Migration drift risk between schemas
    - Already use MySQL in prod for other tables → bifurcation worse
- **Rejected because:** Schema drift between dev and prod is a worse failure mode.

### Option D — Redis

- ❌ Adds another service. Overkill for ~tens of rules.

---

## Consequences

> [!success] Positive
> - Dev experience unchanged — `notify-rules.json` works as before.
> - Prod gets concurrency + atomicity.
> - One codebase, two backends → forces clean async abstraction.
> - Migration path on first prod start = automatic.

> [!warning] Negative / Trade-offs
> - Two code paths to maintain (`notify-rules.ts` dual-mode logic).
> - JSON and MySQL serializers can drift if not tested together.
> - Array fields (`origins`, `destinations`, `vehicle_types`) JSON-stringified in `VARCHAR(4000)` — not natively queryable.
> - Boolean fields stored as `INT(0/1)` for MySQL 5.7 compat → small mental tax.

> [!info] Neutral / Follow-ups
> - SSE broadcasts rule changes to Web UI in real-time — works the same in both modes.
> - `ensureDashboardTables()` in `client.ts` handles runtime schema creation for hot-deploy scenarios.
> - Consider adding `notify_rules_v2` table with proper JSON columns if MySQL upgraded to 8.0+.

---

## Implementation Notes

### File / Module

- Engine: `src/services/notify-rules.ts`
- Schema: `src/db/schema.ts` (drizzle) + `migrations/001_*.sql`
- Runtime table create: `src/db/client.ts` → `ensureDashboardTables()`

### Schema (MySQL 5.7)

```sql
CREATE TABLE notify_rules (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  origins VARCHAR(4000),
  destinations VARCHAR(4000),
  vehicle_types VARCHAR(4000),
  need INT,
  enabled INT(1) DEFAULT 1,
  fulfilled INT(1) DEFAULT 0,
  auto_accept INT(1) DEFAULT 0,
  auto_accepted INT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

### EBUSY Workaround

Docker overlay FS sometimes returns `EBUSY` on file lock. JSON writer falls back to **direct overwrite** (no lock).

---

## References

- [[SPX-Project-Rules]]
- Repository: `src/services/notify-rules.ts`
- Repository: `src/db/migration-sql.ts`
- Repository: `src/db/client.ts` (look for `ensureDashboardTables`)

## Related ADRs

- *(none yet — this is the first)*
