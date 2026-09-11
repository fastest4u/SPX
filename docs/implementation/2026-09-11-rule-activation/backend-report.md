# Rule activation review backend — 2026-09-11

Implemented the agreed preview/save contract. Active HTTP creates and updates require a five-minute HMAC review bound to the authenticated actor, resolved team, create versus existing rule ID, normalized effective values, and the existing rule snapshot. Tokens and acknowledgements are transient. Audit text records actual mode and acknowledgement flags without tokens or keys.

Preview uses the same permission-filtered effective input as save. Ordinary users cannot select `accept_all` on create or change it on edit; existing admin-set whole-booking mode survives a user edit and is reported correctly by preview. Empty filter axes require wildcard acknowledgement and whole-booking mode separately requires `acknowledgeAcceptAll`. Blank names receive a safe validation error. Completion flags derive from `need`, matching DB reads, so `fulfilled=true` with a positive target cannot bypass review.

`accept_all` still means accepting the matched booking as a whole. A target of one may accept multiple requests in that booking. Poller/notifier selection, acceptance calls and counters were not changed. History preview remains a sample of matching history rows; it does not predict live provider availability or cap whole-booking acceptance.

## Concurrent writes

- `readRuleForReview` reads the selected team's rule directly without the poller cache.
- `updateRule` accepts an optional expected snapshot. A fresh-read comparison and SQL conditional update protect every persisted configuration/status value. Text predicates compare binary values so MySQL text collation cannot hide a concurrent edit.
- HTTP completed/disabled edits also use the guard unless explicitly disabling, since another writer could activate them after the handler's initial read.
- Explicit `enabled=false` remains available without a token or snapshot gate. Disabled writes only set explicitly supplied patch fields; a quick disable cannot restore stale `need` or completion flags over concurrent acceptance progress.
- The development JSON read/check/write branch remains synchronous within a process. It is not cross-process file locking.

## Files changed

- `src/controllers/rules-controller.ts`
- `src/services/rule-activation-review.ts` (new)
- `src/services/notify-rules.ts` (root-authorized scoped fresh read, optional conditional update, and disable preservation)
- `tests/rules-activation-review.test.ts` (new)
- `tests/rules-controller-admin-scope.test.ts` (review fixture added for intentional API gate)
- This report.

## Verification

Tests were written first. Initial HTTP baseline failed for the intended missing gate/token/name validation. Additional deterministic memory-DB interleavings first reproduced a completed-rule race and stale progress restored during disabling; both pass after their scoped fixes.

Final focused run: **22 test records passed, zero failures**. Includes actual Fastify requests and memory persistence, active/disabled/done saves, warning acknowledgements, tampering/expiry/field changes, actor/team/operation/rule-ID binding, user mode permissions, stale snapshots, concurrent HTTP edits, competing writes after both snapshot reads, emergency disable progress preservation, and existing matching/admin-scope regression checks.

Run from an isolated temporary directory containing no `.env`:

```powershell
Set-Location -LiteralPath (Join-Path $env:TEMP 'spx-rule-review-tests')
$env:NODE_ENV = 'test'
$env:DB_MODE = 'memory'
$env:HTTP_ENABLED = 'false'
$env:JWT_SECRET = 'rule-review-synthetic-jwt-key-at-least-32-chars'
node C:/Users/Server/Desktop/SPX/node_modules/tsx/dist/cli.mjs --test C:/Users/Server/Desktop/SPX/tests/rules-activation-review.test.ts C:/Users/Server/Desktop/SPX/tests/rules-controller-admin-scope.test.ts C:/Users/Server/Desktop/SPX/tests/notify-rules-matching.test.ts
```

The strict scoped backend TypeScript check passed (application Fastify JWT type augmentation included):

```powershell
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck --strict --types node,@fastify/jwt src/controllers/rules-controller.ts src/services/rule-activation-review.ts src/services/notify-rules.ts
```

Full `npm run typecheck:backend` remains blocked by existing unrelated A3/Gate6/realtime missing exports/types. That run emitted no diagnostics in the changed backend files. No unrelated fixes, live MySQL/provider calls, secrets-file reads, build artifacts, commits, branches, pushes or deployment occurred.

References used: [Fastify testing](https://github.com/fastify/fastify/blob/main/docs/Guides/Testing.md), [Drizzle conditional data querying](https://github.com/drizzle-team/drizzle-orm-docs/blob/main/src/content/docs/data-querying.mdx), and [Node crypto digest comparison](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b).
