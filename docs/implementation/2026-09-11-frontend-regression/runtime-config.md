# Frontend runtime configuration regression — 2026-09-11

The failing baseline test was an unfinished frontend configuration contract, not a regression introduced by the rule editor or provider authentication changes. Both `src/frontend/lib/runtime-config.ts` and `tests/frontend-runtime-config.test.ts` were already untracked. The existing Phase 4 plan (`docs/superpowers/plans/2026-07-10-phase-4-frontend-runtime-config-degraded-ui.md`, Task 1) specifies configurable API paths and a default configuration-backed metrics client, but `api.ts` still hardcoded `/api`, `/metrics`, and `/metrics/history` and exported neither expected factory.

The bounded fix integrates the existing configuration object into the real API client. `API_BASE` now reads `apiBaseUrl`; auth-exempt paths derive from that same base; `createMetricsApi(config)` resolves snapshot/history URLs; and the exported `metricsApi` is created from the default runtime configuration. The fallback defaults preserve existing routes. URL pathname parsing now works with absolute configured bases during Node tests as well as in a browser.

There are no unused compatibility stubs. Provider credentials still use the separate no-replay request path, cookie credentials remain included, ordinary requests refresh and retry once, and auth endpoint failures remain terminal. System pause/resume remain on their existing web control routes. Rule preview receipt fields and team scoping were retained. SSE, runtime status, fallback polling, and unfinished A3 backend work were not integrated or certified by this change.

## Evidence

- Before the fix, `frontend-runtime-config.test.ts` reported `createAuthExemptPaths is not a function`.
- The new `frontend-configured-api-auth.test.ts` first failed on the real exported auth client issuing `/api/login` instead of the configured `https://web-api.example/gateway/api/login`.
- The new test now verifies configured auth/rules/metrics/provider client requests, terminal auth exceptions, one refresh plus one retry, terminal second-401 redirect, no provider credential replay, and unchanged control mutation routing. Its fetch double substitutes only the network boundary; no requests reach a server.
- Passed: `frontend-runtime-config.test.ts`, `frontend-configured-api-auth.test.ts`, `frontend-api-auth.test.ts`, `frontend-provider-auth.test.ts`, and `frontend-rule-review.test.ts`, each run directly through `node node_modules/tsx/dist/cli.mjs`.
- Passed: `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.frontend-check.json`.
- Passed: strict standalone TypeScript check of the new configured-client test with ES2022/DOM, ESNext/Bundler resolution, and Node types.

## Files touched in this subtask

- `src/frontend/lib/api.ts` — bounded configuration integration; existing dirty rule/provider edits preserved.
- `tests/frontend-configured-api-auth.test.ts` — new integration regression test.
- This report.

The preexisting runtime-config module and baseline runtime-config test were read but not edited. No browser, Playwright, harness, generated output, secret files, live APIs, database, commits, or deployment were used. Root owns memory lifecycle `memory-1789139303922`.
