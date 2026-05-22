---
title: Auto Memory Digest
type: insight
derived-from:
  - 05_Agent_Session_Logs/2026-05-13-Awaken-Slash-Command.md
  - 05_Agent_Session_Logs/2026-05-13-Awakened-AI-Hardening-Pass.md
  - 05_Agent_Session_Logs/2026-05-13-Awakening-Stack.md
  - 05_Agent_Session_Logs/2026-05-13-Dataview-Integration.md
  - 05_Agent_Session_Logs/2026-05-13-Dream-Compactor.md
  - 05_Agent_Session_Logs/2026-05-13-Full-Verify-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-Local-Env-Setup.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Debt-And-Alert-Policy.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Quality-And-Deploy-Safety.md
  - 05_Agent_Session_Logs/2026-05-13-Memory-Verify-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-Move-Vault-Into-SPX.md
  - 05_Agent_Session_Logs/2026-05-13-Multi-AI-Acceptance-Cascade.md
  - 05_Agent_Session_Logs/2026-05-13-Production-Schema-Verify.md
  - 05_Agent_Session_Logs/2026-05-13-Session-Threads-And-AI-Tool-Profiles.md
  - 05_Agent_Session_Logs/2026-05-13-Setup-MCP-Servers.md
  - 05_Agent_Session_Logs/2026-05-13-Strict-Review-Workflow-Gate.md
  - 05_Agent_Session_Logs/2026-05-13-System-Survey-Awakened-AI-Update.md
  - 05_Agent_Session_Logs/2026-05-13-Templater-Linter-Integration.md
  - 05_Agent_Session_Logs/2026-05-13-Vault-Completion-100-Percent.md
  - 05_Agent_Session_Logs/2026-05-13-Vault-Hardening-Pass-2.md
  - 05_Agent_Session_Logs/2026-05-13-Vault-Hardening-Pass-3.md
  - 05_Agent_Session_Logs/2026-05-13-Vault-Production-Hardening.md
  - 05_Agent_Session_Logs/2026-05-21-add-line-image-listener-for-spx-group-run-sheet-ocr.md
  - 05_Agent_Session_Logs/2026-05-21-assess-custom-agent-runtime-using-codex-auth-provider.md
  - 05_Agent_Session_Logs/2026-05-21-auto-accept-partial-accept-bug-fix.md
  - 05_Agent_Session_Logs/2026-05-21-Auto-Accept-Partial-Fix.md
  - 05_Agent_Session_Logs/2026-05-21-codex-auth-image-reading-api-prototype.md
  - 05_Agent_Session_Logs/2026-05-21-enhance-auto-memory-management-to-4-layer-system.md
  - 05_Agent_Session_Logs/2026-05-21-fix-spx-codex-auth-device-code-404.md
  - 05_Agent_Session_Logs/2026-05-21-fix-spx-codex-auth-internal-server-error-handling.md
confidence: medium
status: active
created: 2026-05-22
updated: 2026-05-22
tags:
  - digest
  - auto-compact
  - project/general
---
# Auto Memory Digest

Generated: 2026-05-22

> [!important]
> This note is generated from recent session logs. Keep durable architectural choices in ADRs and keep repeated lessons here or in dedicated insight notes.

## High-Signal Outcomes
- ### #1 Created `.windsurf/workflows/awaken.md`
- The `/awaken` workflow has 5 phases:
- | Phase | What it reads | Purpose |
- |---|---|---|
- | 1. Strategic Context | Goals, Open-Followups, Session-Threads, Vault-Dashboard | Know the big picture |
- | 2. Tactical Context | Last 3 session logs, ADRs, Insights, Mistakes | Know recent history |
- | 3. Code State (optional) | `src/`, `package.json` | Know what's incomplete in code |
- | 4. Analyze & Rank | Internal questions about goal alignment, blockers, gaps | Filter and prioritize |
- Added `scripts/memory-eval.mjs` and `npm run memory:eval`.
- Extended `scripts/memory-check.mjs` to fail active docs containing known stale SPX truth claims.
- Added [[Memory-Evaluation-Test]] to document the evaluation matrix.
- Added [[ADR-002-DB-Backed-Live-Settings]].
- Added [[Runbook-Production-Schema-Verification]].
- Added [[Runbook-Multi-AI-Memory-Acceptance]].
- Added [[Mistake-002-Stale-Memory-Docs-Overrode-Source]].
- Added [[Mistake-003-Baseline-Migration-Drift]].
- ### Level 2 — Reflection (Mistake-Awareness)
- Created `memory/08_Mistakes/README.md` — registry purpose + Dataview indexes
- Wrote `memory/08_Mistakes/Mistake-001-Wrong-Env-Var-Name-GitHub-MCP.md` — first real entry (~10 min wasted on `github_token` vs `GITHUB_PERSONAL_ACCESS_TOKEN`)
- Created `memory/99_Templates/Template-Mistake.md` — Templater-enabled, prompts for severity, agent, area
- Added `confidence` field convention to vault `AGENTS.md`
- ### Level 3 — Identity (Self & Goals)
- Created `memory/AGENT-IDENTITY.md` — "Who am I on SPX?" — role, traits, standing beliefs, limits, what I don't know
- Created `memory/00_Index/Goals.md` — G-001 through G-006 goal stack with lifecycle (backlog → active → done)
- Verified Dataview plugin active (via `mcp5_obsidian_list_notes` discoverability).
- Rewrote [[MOC-Home]] sections:
- "Most Recent" → auto-query last 10 edited notes
- "Layer 2 Memory" → auto-tables per folder
- "By Topic" → tag-driven `LIST FROM #tag` blocks
- "Vault Health" → stale / orphan / type-count queries

## Decisions To Remember
- **Name it `/awaken`** (not `/next` or `/plan`) to fit the Awakened AI theme and the user's word "ตื่นรู้".
- **5-phase structure** ensures the AI loads strategic context before tactical, preventing myopic suggestions.
- **Top-3 output** prevents overwhelming the user while still giving options.
- **Optional code state (step 9-10)** because the workflow should work for pure memory/docs work too.
- ---
- Treat `memory:eval` as the acceptance test for core Awakened AI retrieval coverage.
- Treat known stale high-risk project claims as `memory:check` errors in active docs.
- Keep historical notes such as session logs, ADRs, mistakes, and sources excluded from stale-claim enforcement.
- **L2 mistake registry uses sequential ID `Mistake-NNN`** — like ADRs, IDs never reused. Future-proof and stable links.
- **`confidence:` is YAML for insights/mistakes, prose for sessions/ADRs** — different types have different verbosity needs.
- **Identity file lives at vault root, not `00_Index/`** — `AGENT-IDENTITY.md` is fundamental, deserves top-level visibility.
- **Three personas (not six)** in `/multi-perspective` — compressed from Six Thinking Hats. Optimizer + Critic + Devil's Advocate covers 80% of value at 50% of overhead.
- **Workflows are slash-commands, not auto-triggered** — keeps AI explicit. Auto-triggering would create surprise.
- **MOC manual lists are now legacy** — any future agent finding manual `- [[Note]]` lists in MOCs should consider replacing with Dataview queries.
- **`type` field is the primary filter** — every Dataview query in this vault uses `WHERE type` to skip `.base` and orphan files.
- **Hyphenated field gotcha documented** — `decision-date`, `derived-from`, etc. need bracket-syntax in `WHERE`.
- **Vault-Dashboard ≠ MOC-Home** — MOC = navigation, Dashboard = maintenance. Different jobs.
- **Create 2 insights, not 4.** Only the clearest recurring patterns (appearing in 3+ and 2+ logs respectively) were promoted. Lesser patterns remain as session-log learnings.
- **No archive this pass.** Every note is from today and active.
- **ADR-001 and ADR-002 remain accepted.** No new architectural decisions contradict them.
- Use `npm run verify` as the repo-wide gate name because it is short, tool-agnostic, and already matches common package conventions.
- Keep `memory:verify` as the memory-only gate so small vault-only maintenance does not need to rebuild the app.
- Do not print, commit, or include secret values in memory.
- Treat local `.env` as machine-local operational state.
- Historical session tasks that are now represented in [[Goals]] or runbooks should be closed in their source logs to prevent duplicate Memory Quality Debt.
- Multi-AI acceptance remains pending in [[Goals]] and [[Multi-AI-Acceptance-Results]], but duplicate old checkboxes are closed.
- Production alert policy is documented as an operational policy first; code automation can be added later if needed.
- `memory:score` is informational by default so it can be included in `memory:verify` without failing useful work due to known backlog.
- `schema:verify` stays separate from `npm run verify` because it needs DB credentials and may target production.
- Multi-AI results must not be faked. Codex is marked pass; other agents remain pending until tested in their native tools.

## Open Follow-ups
- [ ] Test end-to-end: send a run sheet photo to the SPX group and verify the 5-field reply.
- [ ] Handle large images or timeout gracefully — currently hardcoded 120s timeout.
- [ ] Consider adding a reaction emoji when processing starts (e.g., message.react('NICE')).
- [ ] If the user asks to proceed, design a minimal Provider interface and add an experimental `codex-runtime` provider behind a feature flag.
- [ ] User to decide when to commit + deploy the fix
- [ ] Monitor logs for auto-accept-partial-verified in production
- [ ] Deploy to production server
- [ ] Monitor logs for `auto-accept-partial-verified` to confirm fix works in production
- [ ] Manually test `/api/ai/read-image` with a real authenticated browser/API session and sample image.
- [ ] If this endpoint becomes production-critical, replace Codex CLI auth with an explicit OpenAI API key/service credential.
- [ ] Commit AGENTS.md + workflow changes
- [ ] Monitor auto-accept-partial-verified in production
- [ ] User should restart/reload the SPX backend/frontend and test Codex Login again from Settings.
- [ ] If browser OAuth also proves unstable in production, replace Codex auth dependency with an explicit OpenAI API key/service credential for LINE image OCR.
- [ ] No commit or deploy was performed.
- [ ] If Codex auth remains unstable for production LINE image OCR, switch production usage from Codex device/CLI auth to an explicit OpenAI API key or service credential.
- [ ] User should choose when to commit/deploy these changes; no commit or deploy was performed.

## Confidence Lessons
- Custom runtime via Codex auth is possible but riskier than Codex CLI or OpenAI API key because Codex auth/runtime internals are not a stable backend provider API. -> Keep AI auth integration behind a provider abstraction if experimenting with nonstandard auth boundaries.
- Codex CLI auth can be used by spawning `codex exec` without reading auth token files directly. -> Use Codex CLI as an integration boundary for prototypes, but capture final output via `--output-last-message` because stdout contains banners/logs.

## Verification Evidence
- npm run typecheck passed; test-line-listener.ts confirmed listener starts and connects to SPX group with restored auth token.
- Planning-only; no code changes. Used memory context and multi-perspective review skill.
- Not recorded
- `npx tsx tests/codex-image-reader.test.ts`, `npm run typecheck`, and `npm run build` passed. `codex exec --ephemeral --sandbox read-only "Reply only with OK"` verified Codex CLI auth works, but emitted a deprecation warning for codex_hooks config.
- npm run typecheck passed.

## Source Sessions
- [[05_Agent_Session_Logs/2026-05-13-Awaken-Slash-Command|2026-05-13-Awaken-Slash-Command.md]]
- [[05_Agent_Session_Logs/2026-05-13-Awakened-AI-Hardening-Pass|2026-05-13-Awakened-AI-Hardening-Pass.md]]
- [[05_Agent_Session_Logs/2026-05-13-Awakening-Stack|2026-05-13-Awakening-Stack.md]]
- [[05_Agent_Session_Logs/2026-05-13-Dataview-Integration|2026-05-13-Dataview-Integration.md]]
- [[05_Agent_Session_Logs/2026-05-13-Dream-Compactor|2026-05-13-Dream-Compactor.md]]
- [[05_Agent_Session_Logs/2026-05-13-Full-Verify-Gate|2026-05-13-Full-Verify-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-Local-Env-Setup|2026-05-13-Local-Env-Setup.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Debt-And-Alert-Policy|2026-05-13-Memory-Debt-And-Alert-Policy.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Quality-And-Deploy-Safety|2026-05-13-Memory-Quality-And-Deploy-Safety.md]]
- [[05_Agent_Session_Logs/2026-05-13-Memory-Verify-Gate|2026-05-13-Memory-Verify-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-Move-Vault-Into-SPX|2026-05-13-Move-Vault-Into-SPX.md]]
- [[05_Agent_Session_Logs/2026-05-13-Multi-AI-Acceptance-Cascade|2026-05-13-Multi-AI-Acceptance-Cascade.md]]
- [[05_Agent_Session_Logs/2026-05-13-Production-Schema-Verify|2026-05-13-Production-Schema-Verify.md]]
- [[05_Agent_Session_Logs/2026-05-13-Session-Threads-And-AI-Tool-Profiles|2026-05-13-Session-Threads-And-AI-Tool-Profiles.md]]
- [[05_Agent_Session_Logs/2026-05-13-Setup-MCP-Servers|2026-05-13-Setup-MCP-Servers.md]]
- [[05_Agent_Session_Logs/2026-05-13-Strict-Review-Workflow-Gate|2026-05-13-Strict-Review-Workflow-Gate.md]]
- [[05_Agent_Session_Logs/2026-05-13-System-Survey-Awakened-AI-Update|2026-05-13-System-Survey-Awakened-AI-Update.md]]
- [[05_Agent_Session_Logs/2026-05-13-Templater-Linter-Integration|2026-05-13-Templater-Linter-Integration.md]]
- [[05_Agent_Session_Logs/2026-05-13-Vault-Completion-100-Percent|2026-05-13-Vault-Completion-100-Percent.md]]
- [[05_Agent_Session_Logs/2026-05-13-Vault-Hardening-Pass-2|2026-05-13-Vault-Hardening-Pass-2.md]]
- [[05_Agent_Session_Logs/2026-05-13-Vault-Hardening-Pass-3|2026-05-13-Vault-Hardening-Pass-3.md]]
- [[05_Agent_Session_Logs/2026-05-13-Vault-Production-Hardening|2026-05-13-Vault-Production-Hardening.md]]
- [[05_Agent_Session_Logs/2026-05-21-add-line-image-listener-for-spx-group-run-sheet-ocr|2026-05-21-add-line-image-listener-for-spx-group-run-sheet-ocr.md]]
- [[05_Agent_Session_Logs/2026-05-21-assess-custom-agent-runtime-using-codex-auth-provider|2026-05-21-assess-custom-agent-runtime-using-codex-auth-provider.md]]
- [[05_Agent_Session_Logs/2026-05-21-auto-accept-partial-accept-bug-fix|2026-05-21-auto-accept-partial-accept-bug-fix.md]]
- [[05_Agent_Session_Logs/2026-05-21-Auto-Accept-Partial-Fix|2026-05-21-Auto-Accept-Partial-Fix.md]]
- [[05_Agent_Session_Logs/2026-05-21-codex-auth-image-reading-api-prototype|2026-05-21-codex-auth-image-reading-api-prototype.md]]
- [[05_Agent_Session_Logs/2026-05-21-enhance-auto-memory-management-to-4-layer-system|2026-05-21-enhance-auto-memory-management-to-4-layer-system.md]]
- [[05_Agent_Session_Logs/2026-05-21-fix-spx-codex-auth-device-code-404|2026-05-21-fix-spx-codex-auth-device-code-404.md]]
- [[05_Agent_Session_Logs/2026-05-21-fix-spx-codex-auth-internal-server-error-handling|2026-05-21-fix-spx-codex-auth-internal-server-error-handling.md]]
