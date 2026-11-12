# Repository Guidelines

> **MANDATORY FIRST ACTION (every task):** Your FIRST tool call MUST be `memory_sessionStart` (project-memory MCP) BEFORE reading code, running commands, SSH, or answering — even for quick diagnosis. Then call `memory_selfCheck` before risky work and `memory_sessionEnd` to close, as ONE continuous lifecycle per task. Full rules in "Auto Memory Management (project-memory MCP)" below. No exceptions.

## Project Structure & Module Organization

This is one npm package for a TypeScript SPX bidding poller plus React dashboard. Backend code is in `src/`: `app.ts` boots the app, `controllers/` handles Fastify routes and polling, `services/` contains API/notify/SSE/metrics logic, `db/` holds schemas, and `repositories/` owns persistence. Frontend code is in `src/frontend/`. SQL lives in `migrations/`; scripts live in `src/scripts/` and `scripts/`. Do not edit generated `src/frontend/routeTree.gen.ts`, `dist/`, `data/`, `logs/`, `node_modules/`, `.env`, or `notify-rules.json`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies; keep `.npmrc` for the `@jsr` registry alias.
- `npm run dev`: run `HTTP_ENABLED=true tsx src/app.ts` and Vite together.
- `npm run typecheck`: run backend and frontend TypeScript checks.
- `npm run lint`: run ESLint (`eslint.config.mjs`) across `src/`, `scripts/`, and `tests/`.
- `npm test`: run `scripts/run-tests.mjs` across `tests/*.test.ts` (unit suites run in bounded parallel batches via `TEST_CONCURRENCY`; browser/Playwright suites run serially).
- `npm run build`: CI gate; typechecks, clears `dist/`, bundles backend/scripts, then builds Vite assets.
- `npm run db:generate`: rebuild and regenerate `migrations/001_create_booking_requests.sql`.
- `npm run db:migrate`: rebuild and apply sorted `migrations/*.sql`.
- `npm run schema:verify`: read-only MySQL drift check; requires DB env vars.
- `npm run verify`: production build gate; Memory Vault verification uses project-memory MCP tools.

On PowerShell, POSIX-style scripts such as `test:memory*` may need manual `$env:DB_MODE = "memory"` setup.

## Coding Style & Naming Conventions

Use strict TypeScript. Backend uses `moduleResolution: "NodeNext"`, so keep `.js` suffixes on local relative imports in `.ts` files. Match nearby 2-space style: backend generally uses double quotes and semicolons; frontend/Vite uses single quotes with minimal semicolons. Lint rules live in `eslint.config.mjs` (`npm run lint`); no Prettier config exists.

## Testing Guidelines

Automated tests live in `tests/*.test.ts` and are executed via `npm test` (`node scripts/run-tests.mjs`, which supports file-substring filters and `TEST_CONCURRENCY` bounded parallelism for non-browser suites while running Playwright browser suites serially). Use `npm run typecheck`, `npm run lint`, targeted `node scripts/run-tests.mjs <filter>`, and `npm run build` before shipping. `db:test`, `smoke:test`, and `flow:test` call live SPX/MySQL paths and may insert rows.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `docs:`, `fix:`, and `feat:`. Keep commits scoped and imperative, for example `fix: normalize schema verification rows`. The repo preference is direct-to-`main`; do not create branches, PRs, commits, pushes, or merges unless explicitly asked. For requested PRs, include description, verification, linked context, screenshots for UI changes, and migration/env notes.

## Security & Agent-Specific Instructions

Never read, print, copy, or commit secret values from `.env`. Runtime config is validated in `src/config/env.ts`; trust executable config over prose when docs conflict.

### Auto Memory Management (Project Memory V2 MCP)

Use the `memory_*` **Project Memory V2** MCP tools (`C:\Users\Server\Desktop\Awakened-AI-System\dist\v2.js`) for ALL memory operations.
- **Authoritative V2 Vault**: `C:\Users\Server\Desktop\SPX\memory-v2` (`projectId: 310f00ba-ff0f-47bc-9430-a3a838647462`, `vaultId: 63bf9dcf-d761-493d-b297-a888e220e5b3`, `storeId: 9de5d804-f085-4c97-9866-ad0199be2020`, `releaseId: 5fae44bb-2cf3-4303-bb0c-4d6716e2c812`).
- **Frozen V1 Archive**: The legacy `C:\Users\Server\Desktop\SPX\memory` directory is a cryptographically verified read-only V1 archive (`0o444`) and must never be written to directly.
- Do NOT use obsidian MCP, manual vault file writes, Codex hooks, or removed `npm run memory:*` scripts for memory lifecycle work.

Codex hooks and memory npm scripts are intentionally disabled in this workspace. Do not rely on `.codex/hooks.json` or `scripts/memory-*.mjs` for lifecycle enforcement; call the project-memory V2 MCP tools directly from these instructions and the SPX skills.

#### Project-Memory V2 Tool Map (All 34 Tools — Full-Auto)
Codex should use the V2 project-memory toolkit and auto-select the right tool by task intent. Do not call every tool every turn; choose the smallest useful set.

- **Status & Startup/Context**: `memory_v2Status`, `memory_sessionStart`, `memory_contextPack`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`
- **Read/Search**: `memory_search`, `memory_get`, `memory_list`, `memory_recent`
- **Risk & Verification**: `memory_selfCheck`, `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findDuplicates`, `memory_checkStaleness`
- **Governed Writing**: `memory_writeSessionLog`, `memory_writeADR`, `memory_writeMistake`, `memory_writeInsight`
- **Checkpoints, Recovery & Child Sessions**: `memory_checkpoint`, `memory_recoverSession`, `memory_sessionFork`, `memory_recordChildResult`, `memory_completeChildSession`, `memory_sessionEnd`, `memory_amendSessionEnd`, `memory_cancelSessionEnd`, `memory_recordEvidenceBatch`
- **Governed Lifecycle Transitions**: `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`
- **Operator CLI (`node C:\Users\Server\Desktop\Awakened-AI-System\dist\v2-admin.js`)**: Store status (`status`), backups (`backup`), isolated restores (`restore`), recovery checks (`verify-recovery`), projection rebuilds (`rebuild-projections`), and V1 archive verification (`verify-v1-archive`).

Default routing:
- Start meaningful work with `memory_sessionStart` plus `memory_contextPack` (optionally check `memory_v2Status` to confirm `projectId: 310f00ba-ff0f-47bc-9430-a3a838647462` and `mode: "active"`).
- Before work, call `memory_followUpRadar`; before risky work, call `memory_selfCheck`.
- For memory verification, use `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findDuplicates`, and `memory_checkStaleness`.
- For durable learning, use `memory_writeADR`, `memory_writeMistake`, `memory_writeInsight`, `memory_writeSessionLog`, or `memory_sessionEnd` rather than editing files manually.
- For governed record lifecycle transitions, use `memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, and `memory_forgetEvidence`.

#### Lifecycle Summary
Every meaningful task should follow this MCP-native V2 loop:

1. Start with `memory_sessionStart`, `memory_contextPack`, and `memory_followUpRadar`.
2. Run `memory_selfCheck` before risky work.
3. Use targeted retrieval, verification, governance, checkpoint, and writing tools from the V2 tool map as the task requires.
4. End with `memory_sessionEnd`; include concrete `topic`, `outcomes`, `decisionsMade`, `filesTouched`, `openFollowUps`, and `verification` evidence.
5. Verify health via `memory_verifyVault` / `memory_v2Status` and record that result in the final response and session log.

#### Layer 1 — Session Start (every new chat)
Call `memory_sessionStart` automatically on the first substantive user request.
Then call `memory_contextPack` with the appropriate mode and `taskArea` inferred from the request:
- `mode: "coding"` — feature or refactor work
- `mode: "debugging"` — error or bug investigation
- `mode: "deploy"` — deploy, commit, push, production tasks
- `mode: "planning"` — architecture or design discussion
- `mode: "docs"` — memory, documentation, or vault tasks

#### Layer 2 — Before Starting Work (every task)
Call `memory_followUpRadar` with the current task area to surface related open follow-ups from previous sessions. Mention any relevant unclosed items to the user before proceeding.

#### Layer 3 — Before Risky Work (conditional)
Call `memory_selfCheck` before any work involving:
- Production deploy, `docker compose`, SSH to server
- DB schema changes, migrations
- Auth, secrets, `.env` changes
- Multi-file refactors affecting `src/services/` or `src/controllers/`
- Any change to `notify-rules.json` or auto-accept logic

#### Layer 4 — Session End (after meaningful work)
Call `memory_sessionEnd` automatically after any of:
- Completed a feature, bug fix, or refactor
- Made an architectural decision → also call `memory_writeADR`
- Resolved a debugging session → also call `memory_writeMistake` if a new bug pattern was found
- User says "done", "เสร็จแล้ว", "save this", "ship it"
- Approaching context limit

If the same problem pattern appeared in ≥ 2 previous sessions → also call `memory_writeInsight` (and `memory_promote` when verified) to promote it as a durable lesson.

### Commit & Deploy Policy

After code changes: stop at typecheck passing and explain the changes. **Do NOT auto-commit or auto-deploy** unless the user explicitly asks. The user decides when to commit and when to deploy to production.

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->
