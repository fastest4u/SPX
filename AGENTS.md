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
- `npm run memory:verify`: Memory Vault check/eval/score.
- `npm run verify`: full memory gate plus production build.

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

Use `mcp5_*` tools (project-memory MCP) for ALL memory operations. Do NOT use obsidian MCP or manual file writes for memory management.

#### Layer 1 — Session Start (every new chat)
Call `mcp5_memory_sessionStart` automatically on the first substantive user request.
Then call `mcp5_memory_contextPack` with the appropriate mode and `taskArea` inferred from the request:
- `mode: "coding"` — feature or refactor work
- `mode: "debugging"` — error or bug investigation
- `mode: "deploy"` — deploy, commit, push, production tasks
- `mode: "planning"` — architecture or design discussion
- `mode: "docs"` — memory, documentation, or vault tasks

#### Layer 2 — Before Starting Work (every task)
Call `mcp5_memory_followUpRadar` with the current task area to surface related open follow-ups from previous sessions. Mention any relevant unclosed items to the user before proceeding.

#### Layer 3 — Before Risky Work (conditional)
Call `mcp5_memory_selfCheck` before any work involving:
- Production deploy, `docker compose`, SSH to server
- DB schema changes, migrations
- Auth, secrets, `.env` changes
- Multi-file refactors affecting `src/services/` or `src/controllers/`
- Any change to `notify-rules.json` or auto-accept logic

#### Layer 4 — Session End (after meaningful work)
Call `mcp5_memory_sessionEnd` automatically after any of:
- Completed a feature, bug fix, or refactor
- Made an architectural decision → also call `mcp5_memory_writeADR`
- Resolved a debugging session → also call `mcp5_memory_writeMistake` if a new bug pattern was found
- User says "done", "เสร็จแล้ว", "save this", "ship it"
- Approaching context limit

If the same problem pattern appeared in ≥ 2 previous sessions → also call `mcp5_memory_writeInsight` to promote it as a durable lesson.

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
