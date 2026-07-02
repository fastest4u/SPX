# SPX Awaken Next Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the current awaken follow-ups by validating frontend E2E behavior, fixing production deploy runbook drift, and making the worktree safer to review.

**Architecture:** Keep production behavior unchanged. Update only documentation and test/hygiene surfaces, then prove the current frontend with existing memory-mode E2E flows. Avoid broad staging or commits because this repo may contain unrelated memory-generated changes.

**Tech Stack:** TypeScript, Fastify, React 19, Vite, Playwright, project-memory MCP.

---

## File Structure

- Modify: `memory/09_Runbooks/Runbook-Production-Deploy.md`
  - Replace legacy `app` compose service references with current `notifier`, `worker-ifn`, and `worker-ptwl` service names from `docker-compose.yml`.
- Modify: `scripts/run-e2e.mjs`
  - Run both `tests/admin-ui-e2e.test.ts` and `tests/user-ui-e2e.test.ts` in headless mode-friendly sequence.
- Inspect/verify: `tests/admin-ui-e2e.test.ts`
  - Existing admin CRUD and responsive coverage.
- Inspect/verify: `tests/user-ui-e2e.test.ts`
  - Existing standard-user CRUD and responsive coverage.
- Delete: `__chk.mjs`
  - Untracked scratch script that reads `.env` and connects to MySQL.
- Do not edit: `.env`, `notify-rules.json`, generated `src/frontend/routeTree.gen.ts`, `dist/`, `data/`, `logs/`, `node_modules/`.

## Task 1: Production Runbook Drift

**Files:**
- Modify: `memory/09_Runbooks/Runbook-Production-Deploy.md`
- Reference: `docker-compose.yml`

- [x] **Step 1: Update deploy inspection commands**

Replace legacy single-service log commands with service-aware commands:

```bash
docker compose logs --tail=200 notifier worker-ifn worker-ptwl
docker compose logs -f notifier worker-ifn worker-ptwl
```

- [x] **Step 2: Update verification checklist**

Use current service health expectations:

```markdown
- [ ] `docker compose ps` shows `notifier` as healthy and both workers running/healthy.
```

- [x] **Step 3: Update metadata**

Set `last-verified`, `updated`, and changelog date to `2026-07-02`.

## Task 2: E2E Runner Coverage

**Files:**
- Modify: `scripts/run-e2e.mjs`
- Verify: `tests/admin-ui-e2e.test.ts`
- Verify: `tests/user-ui-e2e.test.ts`

- [x] **Step 1: Run current E2E runner**

Run:

```powershell
$env:E2E_HEADLESS = "true"; npm run test:e2e
```

Expected: current runner executes admin E2E only. If it fails, debug before changing scope.

- [x] **Step 2: Update runner to execute both suites**

Run `tests/admin-ui-e2e.test.ts`, then `tests/user-ui-e2e.test.ts`, each with:

```js
env: { ...process.env, RUN_E2E: "true", E2E_HEADLESS: process.env.E2E_HEADLESS ?? "true" }
```

- [x] **Step 3: Run full E2E again**

Run:

```powershell
$env:E2E_HEADLESS = "true"; npm run test:e2e
```

Expected: admin and user browser automation both pass.

## Task 3: Worktree Hygiene

**Files:**
- Delete: `__chk.mjs`
- Inspect only: `memory/.memory-mcp/*`, untracked memory session logs, source-date notes.

- [x] **Step 1: Remove scratch script**

Delete `__chk.mjs`; it reads `.env` and live MySQL credentials if executed.

- [x] **Step 2: Inventory remaining changes**

Run:

```powershell
git status --short
git diff --stat
```

Expected: worktree still contains memory-generated files and intentional docs/test-runner changes; no scratch top-level script remains.

## Task 4: Verification

**Files:**
- Verify docs and memory notes with project-memory MCP tools.
- Verify code with repo scripts.

- [x] **Step 1: Typecheck**

Run:

```powershell
npm run typecheck
```

- [x] **Step 2: Build**

Run:

```powershell
npm run build
```

- [x] **Step 3: E2E**

Run:

```powershell
$env:E2E_HEADLESS = "true"; npm run test:e2e
```

- [x] **Step 4: Memory verification**

Run:

```text
memory_verifyNote(memory/09_Runbooks/Runbook-Production-Deploy.md)
memory_verifyVault(includeWarnings=true)
```

- [x] **Step 5: Final diff review**

Run:

```powershell
git status --short
git diff --stat
```

Report remaining untracked/generated memory files honestly and do not commit unless explicitly asked.
