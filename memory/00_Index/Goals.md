---
title: Goals - Long-Term Goal Stack
type: goals
status: active
created: 2026-05-13
updated: 2026-05-13
tags:
  - meta
  - goals
  - planning
aliases:
  - Goal Stack
  - Long-Term Goals
  - Roadmap
---

# Goals - Long-Term Stack

> [!abstract] Purpose
> Keep durable project direction visible across sessions so AI agents do not lose the thread.

---

## Active Goals

### G-001: Bullet-Proof Memory Vault System

- Status: in-progress
- Started: 2026-05-13
- Target: stable multi-AI usage
- Owned by: Cascade + Human + AI agents
- Why it matters: Less repeated context and fewer stale assumptions.

Progress:

- [x] Bootstrap vault with 3-layer architecture.
- [x] Install Dataview, Templater, and Linter.
- [x] Move vault into SPX repo.
- [x] Add mandatory auto-log rule.
- [x] Add Awakening Stack with memory, reflection, identity, and self-checking.
- [x] Add machine-checkable vault linter (`npm run memory:check`).
- [x] Add retrieval protocol, runbooks, and truth-maintenance fields.
- [x] Add first real API and component docs ([[API-Bidding-Endpoints]], [[Component-Retry-With-Backoff]]).
- [x] Add source-grounded Awakened AI operating model ([[Awakened-AI-System]]).
- [x] Add source-grounded SPX system map ([[SPX-System-Map]]).
- [x] Add deterministic memory evaluation (`npm run memory:eval`) and stale-truth detection.
- [x] Add one-command Memory Vault gate (`npm run memory:verify`).
- [x] Add full code + memory verification gate (`npm run verify`).
- [x] Add Memory Quality Score dashboard command (`npm run memory:score`).
- [x] Add Multi-AI acceptance result registry ([[Multi-AI-Acceptance-Results]]).
- [x] Triage old session follow-up debt into Goals, runbooks, or closed historical tasks.
- [x] Commit memory vault to git.
- [ ] Test multi-AI access beyond Codex in native tools.

### G-002: SPX Stable Production Operation

- Status: in-progress
- Started: 2026-04-25
- Target: zero unplanned restarts
- Owned by: Human
- Why it matters: Production reliability equals user trust.

Progress:

- [x] Dual-storage notify rules ([[ADR-001-Dual-Storage-Notify-Rules]]).
- [x] Auto-deploy via git push to main.
- [x] Health check at `GET /ready`.
- [x] DB-backed live settings documented in [[SPX-System-Map]].
- [x] Fresh setup migration SQL aligned with current schema.
- [x] Production schema verification runbook added ([[Runbook-Production-Schema-Verification]]).
- [x] DB-backed live settings ADR added ([[ADR-002-DB-Backed-Live-Settings]]).
- [x] Read-only schema verification command added (`npm run schema:verify`).
- [x] Production schema verified against source contract with `npm run schema:verify` on 2026-05-13.
- [x] Deploy safety checklist added ([[Runbook-Deploy-Safety-Checklist]]).
- [x] Define alerting policy ([[Runbook-Production-Alert-Policy]]).
- [x] Add deeper metrics dashboard policy for poll latency ([[Runbook-Production-Alert-Policy#Poll Latency High]]).

### G-003: Reduce Re-Explanation by 80 Percent

- Status: in-progress
- Started: 2026-05-13
- Target: by 2026-06-13
- Owned by: AI + Human
- Why it matters: A stable shared memory turns every session into incremental work.

Progress:

- [x] Root `AGENTS.md` project-level instructions.
- [x] Memory Vault with session logs.
- [x] Agent identity file.
- [x] Mistake registry.
- [x] Retrieval shortcuts for whole-system, API, SSE, poller, and rules tasks.
- [x] Multi-AI acceptance runbook added ([[Runbook-Multi-AI-Memory-Acceptance]]).
- [x] Memory eval test added ([[Memory-Evaluation-Test]]).
- [x] Memory quality score added ([[Memory-Quality-Score]]).
- [ ] Measure repeated-context messages across 4 weeks.

---

## Recurring Maintenance

### M-001: Monthly Vault Compactor

- Status: active
- Cadence: 1st of each month
- Next run: 2026-06-01
- Owner: AI + Human review

Outcomes to verify:

- [ ] Promote recurring insights to `07_Insights/`.
- [ ] Mark stale notes or re-verify `last-verified` dates.
- [ ] Refresh [[MOC-Home]] if topology changes.
- [ ] Test Dataview render in Obsidian.
- [ ] Test Templater templates manually.
- [ ] Test Cascade session workflows if Cascade is available.
- [ ] Write a session log for the compactor pass.

### M-002: Runbook Re-Verification

- Status: active
- Cadence: every 90 days per runbook
- Owner: Human + AI

Outcome:

- [ ] Walk through each runbook procedure and update `last-verified`.

---

## Backlog

### G-004: API Documentation Coverage

- Status: in-progress

Progress:

- [x] Bootstrap folder index: [[02_API_Docs/README]].
- [x] External API doc: [[API-Bidding-Endpoints]].
- [x] Internal HTTP API doc: [[API-Internal-HTTP]].
- [x] SSE event payload doc: [[API-SSE-Events]].
- [ ] Add dedicated auth/session doc if auth changes again.

### G-005: Reusable Component Coverage

- Status: in-progress

Progress:

- [x] Bootstrap folder index: [[03_Reusable_Components/README]].
- [x] Retry/backoff component: [[Component-Retry-With-Backoff]].
- [x] Poller orchestration component: [[Component-Poller-Orchestration]].
- [x] Dual-storage rules component: [[Component-Dual-Storage-Notify-Rules]].
- [ ] Add SSE broadcaster component if stream code changes.
- [ ] Add MVC controller pattern doc if controller surface grows.

### G-006: Multi-Agent Orchestration

- Status: backlog
- Why: Run specialized agents for security, tests, docs, and implementation in parallel when tooling supports it.
- Trigger: User asks for multi-agent work or a large enough task requires parallel slices.

### G-007: Verification Automation

- Status: backlog
- Why: Direct pushes to `main` auto-deploy, so optional automation can reduce reliance on human discipline.
- Trigger: Team grows, branch/PR workflow starts, or manual `npm run verify` is skipped.

Progress:

- [ ] Add local pre-push hook for `npm run verify` if the workflow tolerates slower pushes.
- [ ] Add GitHub Action for `npm run verify` if PR/branch workflow becomes active.

---

## Recently Completed

| Goal | Completed | Outcome |
|---|---|---|
| Memory Vault bootstrap | 2026-05-13 | Vault created with indexes, templates, runbooks, and session logs. |
| Move vault to SPX repo | 2026-05-13 | Shared memory now lives beside code. |
| Awakening Stack | 2026-05-13 | Identity, goals, mistakes, self-checking, and retrieval protocol added. |
| Source-grounded system survey | 2026-05-13 | [[Awakened-AI-System]], [[SPX-System-Map]], internal API/SSE docs, and component docs added. |
| Awakened AI hardening pass | 2026-05-13 | `memory:eval`, stale-truth detector, ADR-002, schema verification, multi-AI acceptance, and mistake notes added. |
| Full verification and safety pass | 2026-05-13 | `memory:score`, `schema:verify`, deploy checklist, multi-AI result registry, and extra mistake entries added. |
| Memory debt and alert policy pass | 2026-05-13 | Session follow-ups triaged, [[Defense-In-Depth-Vault-Architecture]] promoted, and [[Runbook-Production-Alert-Policy]] added. |

---

## Related

- [[AGENT-IDENTITY]]
- [[MOC-Home]]
- [[AGENTS]]
- [[Awakened-AI-System]]
- [[SPX-System-Map]]
