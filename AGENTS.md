# Repository Guidelines

## Project Structure & Module Organization

This is one npm package for a TypeScript SPX bidding poller plus React dashboard. Backend code is in `src/`: `app.ts` boots the app, `controllers/` handles Fastify routes and polling, `services/` contains API/notify/SSE/metrics logic, `db/` holds schemas, and `repositories/` owns persistence. Frontend code is in `src/frontend/`. SQL lives in `migrations/`; scripts live in `src/scripts/` and `scripts/`. Do not edit generated `src/frontend/routeTree.gen.ts`, `dist/`, `data/`, `logs/`, `node_modules/`, `.env`, or `notify-rules.json`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies; keep `.npmrc` for the `@jsr` registry alias.
- `npm run dev`: run `HTTP_ENABLED=true tsx src/app.ts` and Vite together.
- `npm run typecheck`: run backend and frontend TypeScript checks.
- `npm run build`: CI gate; typechecks, clears `dist/`, bundles backend/scripts, then builds Vite assets.
- `npm run db:generate`: rebuild and regenerate `migrations/001_create_booking_requests.sql`.
- `npm run db:migrate`: rebuild and apply sorted `migrations/*.sql`.
- `npm run schema:verify`: read-only MySQL drift check; requires DB env vars.
- `npm run verify`: production build gate; Memory Vault verification uses project-memory MCP tools.

On PowerShell, POSIX-style scripts such as `test:memory*` may need manual `$env:DB_MODE = "memory"` setup.

## Coding Style & Naming Conventions

Use strict TypeScript. Backend uses `moduleResolution: "NodeNext"`, so keep `.js` suffixes on local relative imports in `.ts` files. Match nearby 2-space style: backend generally uses double quotes and semicolons; frontend/Vite uses single quotes with minimal semicolons. No ESLint or Prettier config exists.

## Testing Guidelines

There is no unit-test framework configured. Use `npm run typecheck` for focused checks and `npm run build` or `npm run verify` before shipping. `db:test`, `smoke:test`, and `flow:test` call live SPX/MySQL paths and may insert rows.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `docs:`, `fix:`, and `feat:`. Keep commits scoped and imperative, for example `fix: normalize schema verification rows`. The repo preference is direct-to-`main`; do not create branches, PRs, commits, pushes, or merges unless explicitly asked. For requested PRs, include description, verification, linked context, screenshots for UI changes, and migration/env notes.

## Security & Agent-Specific Instructions

Never read, print, copy, or commit secret values from `.env`. Runtime config is validated in `src/config/env.ts`; trust executable config over prose when docs conflict.

### Auto Memory Management (project-memory MCP)

Use the `memory_*` project-memory MCP tools for ALL memory operations. Do NOT use obsidian MCP, manual vault file writes, Codex hooks, or removed `npm run memory:*` scripts for Codex memory lifecycle work.

Codex hooks and memory npm scripts are intentionally disabled in this workspace. Do not rely on `.codex/hooks.json` or `scripts/memory-*.mjs` for lifecycle enforcement; call the project-memory MCP tools directly from these instructions and the SPX skills.

#### Project-Memory Tool Map (authoritative for Codex)
Codex should learn the whole project-memory toolkit and auto-select the right tool by task intent. Do not call every tool every turn; choose the smallest useful set.

- Startup/context: `memory_sessionStart`, `memory_contextPack`, `memory_followUpRadar`, `memory_awaken`, `memory_lifecycleStatus`
- Read/search: `memory_search`, `memory_get`, `memory_list`, `memory_recent`
- Risk and verification: `memory_selfCheck`, `memory_verifyVault`, `memory_verifyNote`, `memory_verifySourceTruth`
- Maintenance: `memory_findBrokenLinks`, `memory_findDuplicates`, `memory_checkStaleness`, `memory_reindex`, `memory_indexNote`, `memory_compactVault`
- Structured writing: `memory_sessionEnd`, `memory_writeSessionLog`, `memory_writeADR`, `memory_writeMistake`, `memory_writeInsight`, `memory_createFromTemplate`
- Vault transfer/bootstrap: `memory_export`, `memory_import`, `memory_bootstrapProject`

Default routing:
- Start meaningful work with `memory_sessionStart` plus `memory_contextPack`; confirm `vaultRoot` is `C:\Users\Server\Desktop\SPX\memory`.
- Before work, call `memory_followUpRadar`; before risky work, call `memory_selfCheck`.
- For memory-only verification, use `memory_verifyVault` and targeted validators such as `memory_verifyNote`, `memory_verifySourceTruth`, `memory_findBrokenLinks`, and `memory_checkStaleness`.
- For durable learning, use `memory_writeADR`, `memory_writeMistake`, `memory_writeInsight`, `memory_createFromTemplate`, or `memory_sessionEnd` rather than editing vault notes manually.
- For vault maintenance, use `memory_reindex`, `memory_indexNote`, `memory_compactVault`, `memory_findDuplicates`, `memory_export`, `memory_import`, or `memory_bootstrapProject` only when the task specifically calls for them.

#### Lifecycle Summary
Every meaningful task should follow this MCP-native loop:

1. Start with `memory_sessionStart`, `memory_contextPack`, and `memory_followUpRadar`.
2. Run `memory_selfCheck` before risky work.
3. Use targeted retrieval, verification, maintenance, and writing tools from the tool map as the task requires.
4. End with `memory_sessionEnd`; include concrete outcomes, decisions, files touched, open follow-ups, and verification evidence.
5. If `memory_sessionEnd` cannot verify internally, call `memory_verifyVault` and record that result in the final response and session log.

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

If the same problem pattern appeared in ≥ 2 previous sessions → also call `memory_writeInsight` to promote it as a durable lesson.

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
