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

Never read, print, copy, or commit secret values from `.env`. Runtime config is validated in `src/config/env.ts`; trust executable config over prose when docs conflict. Before meaningful agent work, read `memory/AGENTS.md`, `memory/00_Index/MOC-Home.md`, and recent relevant logs. After meaningful work, add a session log and run `npm run memory:verify`.
