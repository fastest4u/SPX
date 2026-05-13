---
title: "2026-05-13 — Vault Hardening Pass 3 (Git Hygiene + Argv Secrets + First Real Docs)"
type: session-log
session-date: 2026-05-13
agent: cascade
duration-minutes: 30
outcomes:
  - .gitignore now excludes 5.15 MB of plugin binaries while keeping configs trackable; private TLS key in obsidian-local-rest-api remains protected
  - Verified gitignore behavior with git check-ignore (binaries blocked, configs allowed, secrets blocked)
  - Auto-Accept runbook no longer leaks Cookie/JWT through curl argv — switched to chmod 600 header file with trap-cleanup
  - Notify runbook LINE Notify call hardened with same header-file pattern
  - Wrote first real Component doc (Component-Retry-With-Backoff.md) grounded in src/services/api-client.ts
  - Wrote first real API doc (API-Bidding-Endpoints.md) covering all 4 endpoints with retcode reference
  - memory:check final = 0 errors / 0 warnings on 42 files
  - Commit commands prepared (one-shot and two-shot variants); awaiting user approval
created: 2026-05-13
updated: 2026-05-13
tags:
  - session-log
  - project/spx
  - topic/memory-vault
  - topic/security
  - topic/git-hygiene
  - topic/api
---

# 2026-05-13 — Vault Hardening Pass 3

> [!abstract] TL;DR
> Pass 3 closes the remaining 4 gaps from the user's third assessment: (1) plugin-binary git bloat, (2) secrets leaking via curl argv, (3) empty backlog folders without real notes, (4) un-committed state. Done all except the commit itself (user action — Cascade does not auto-`git push` on this repo).

> Confidence: high — every change is verified by automated linter, git check-ignore, and grounded in actual code.

---

## Goal

Make the vault honest about **git** (binaries vs config), **shell security** (no argv leakage), and **content** (real notes, not just READMEs).

→ Advances [[Goals#G-001]] and writes the first entries that satisfy [[02_API_Docs/README]] and [[03_Reusable_Components/README]] backlogs.

---

## What Was Done

### #1 `.gitignore` strategy: ignore plugin binaries, keep configs

Audit result before:

| Plugin | `main.js` size | Track? |
|---|---|---|
| obsidian-local-rest-api | 2.6 MB | ❌ binary |
| dataview | 1.3 MB | ❌ binary |
| obsidian-linter | 0.9 MB | ❌ binary |
| templater-obsidian | 0.3 MB | ❌ binary |
| **Total binaries** | **~5.1 MB** | **excluded** |

Rewrote `.gitignore` Obsidian section with:
- Block `memory/.obsidian/plugins/*/main.js` and `*.styles.css`
- Continue tracking `manifest.json`, `data.json`, `community-plugins.json`, etc.
- Continue blocking `obsidian-local-rest-api/data.json` (TLS private key, RSA private key, apiKey)
- Documented the **positive examples** (what should be tracked) inline as comments — defense against future drift.

Verified with `git check-ignore -v`:

```
.gitignore:24: memory/.obsidian/plugins/*/main.js  → dataview/main.js   (BLOCKED)
.gitignore:21: !memory/.obsidian/**                → dataview/data.json (TRACKED)
.gitignore:33: ...obsidian-local-rest-api/data.json → SAME              (BLOCKED — secret)
.gitignore:28: workspace.json                      → workspace.json     (BLOCKED — per-user)
```

Net effect: **first commit is ~30 KB instead of ~5.2 MB**, and rebuilds remain repeatable since plugin IDs + versions are pinned in `community-plugins.json` + `manifest.json` files.

### #2 Auto-Accept runbook: secrets out of argv

Before:

```bash
curl -X POST http://localhost:3000/api/booking/<id>/accept \
  -H "Cookie: $COOKIE" \
  -H "Authorization: Bearer $JWT"
```

After shell expansion, `$COOKIE` (~1.8 KB session token) lands in `argv` → leaks via `ps aux`, `/proc/<pid>/cmdline`, audit logs, and accounting.

After:

```bash
ssh root@... 'docker exec spx-app sh -c "
set -eu
hdr=$(mktemp); chmod 600 \"$hdr\"
trap \"rm -f \\\"$hdr\\\"\" EXIT INT TERM
printf \"Cookie: %s\n\" \"$COOKIE\" >> \"$hdr\"
printf \"Authorization: Bearer %s\n\" \"$JWT\" >> \"$hdr\"
curl -s -o /dev/null -w \"accept HTTP %{http_code}\n\" \
  -X POST http://localhost:3000/api/booking/<id>/accept \
  -H @\"$hdr\"
"'
```

Why this is safe:
- `argv` only contains `@/tmp/tmp.XXXXXX` — opaque to other processes
- `chmod 600` restricts file to current uid
- `trap … EXIT INT TERM` deletes the file even on SIGINT/SIGTERM
- Whole thing runs **inside the container** so it never touches host shell history

Same pattern applied to `Runbook-Notify-Failure.md` LINE call. Discord (URL-as-secret, no `@file` for URLs) got a `[!note]` callout explaining the asymmetry.

### #3 First real Component doc — `Component-Retry-With-Backoff.md`

Grounded in `src/services/api-client.ts:14-54`. Covers:
- `fetchWithRetry` signature + implementation snippet
- Retryable status set (`408`, `425`, `429`, `5xx`)
- Backoff schedule table (1s → 2s → 4s + jitter)
- 4 callers in the codebase mapped with their retry counts (the `accept` override = 1)
- "When NOT to use" — non-idempotent writes, internal calls, auth failures
- Adjacent `SESSION_EXPIRED_CODES` retcode-expiry pattern
- Failure-mode diagnostic table

### #4 First real API doc — `API-Bidding-Endpoints.md`

Grounded in same file. Covers all 4 endpoints:
1. `POST /booking/bidding/list` — list with pagination via parallel fetch
2. `GET  /booking/bidding/booking_overview?id=<n>` — detail (best-effort)
3. `POST /booking/bidding/request/list` — per-booking request rows (source of `request_id`)
4. `POST /booking/bidding/accept` — auto-accept submission (1 retry override)

Plus retcode reference table (the 5-element `SESSION_EXPIRED_CODES` set), URL derivation rule, header table, cookie-override hot-refresh path, and a failure-modes diagnostic.

Both docs include `source: file:src/services/api-client.ts` + `confidence: high` + `last-verified: 2026-05-13` per the truth-maintenance schema enforced in Pass 2.

---

## Files Touched

### Created (3)
- `memory/02_API_Docs/API-Bidding-Endpoints.md` — first real API doc
- `memory/03_Reusable_Components/Component-Retry-With-Backoff.md` — first real component doc
- `memory/05_Agent_Session_Logs/2026-05-13-Vault-Hardening-Pass-3.md` — this log

### Modified (3)
| File | Change |
|---|---|
| `.gitignore` | Plugin-binary block + positive-example comments |
| `memory/09_Runbooks/Runbook-Auto-Accept-Debug.md` | Manual test now uses chmod-600 header file with trap |
| `memory/09_Runbooks/Runbook-Notify-Failure.md` | LINE Notify call same pattern; Discord asymmetry callout |

---

## Decisions Made

- **Ignore plugin binaries, track plugin configs.** A new clone runs Obsidian → Settings → Enable to install binaries; configs make the install behave the same. Trades 5 MB git bloat for one extra click. Worth it.
- **`obsidian-local-rest-api/data.json` STAYS blocked.** It has a TLS private key + RSA private key. No exception, even though tracking it would be convenient.
- **Header-file pattern beats env-var headers in argv.** Bytes-on-disk briefly with `chmod 600` + `trap` is strictly safer than process args visible to every uid via `/proc`.
- **Discord webhook URL gets a callout, not a redesign.** No clean equivalent of `-H @file` for URLs; the realistic mitigation is "treat the URL like a token, run inside the container."
- **First real docs over more backlog.** Two notes that describe shipped code beat ten notes that promise future work. Each doc has `confidence: high` because they were grounded in the actual file before writing.

---

## Insights / Learnings

> [!example] Defense-in-Depth — 5th recurrence (PROMOTE)
> Same pattern five sessions in a row:
> 1. Pass 0: rules in AGENTS.md
> 2. Pass 1: linter enforces rules
> 3. Pass 1: linter has correct semantics
> 4. Pass 2: linter enforces NEW invariants (truth-maintenance)
> 5. Pass 3: git itself enforces invariants (gitignore audited via `check-ignore`)
>
> The system catches the previous session's drift at every layer. **Promote to `07_Insights/Defense-In-Depth-Vault-Architecture.md` next session.**

> [!warning] argv leakage is invisible until you look
> A `-H "Cookie: $X"` line looks safe in a script. The leak only manifests in `/proc/<pid>/cmdline` and `ps aux` snapshots, neither of which appear in normal output. Documenting the safer pattern explicitly is necessary because the unsafe pattern is the natural one to write.

> [!tip] Grounded docs > generic docs
> Both new docs were written **after** reading the source file in full. Result: every claim cites a line/symbol, all retry constants are exact (`MAX_RETRIES = 3`, `BASE_DELAY_MS = 1000`), all retcode values listed (`{ 401, 403, -1, 10001, 10002 }`). When the code changes, re-verifying these is mechanical.

---

## Open Issues / Follow-ups

- [ ] **User action — `git commit + push`.** Commands at the bottom of this log.
- [ ] Promote "Defense-in-Depth Vault Architecture" insight (5th recurrence threshold met)
- [ ] Next time `notifier.ts` is touched → write `Component-Discord-Embed-Builder.md`
- [ ] Next time `notify-rules.ts` is touched → write `Component-Dual-Storage-Repository.md`
- [ ] Next time poller logic changes → write `Component-Poller-Tick.md`
- [ ] Decide on Linter Option A vs Option B (carry-over from Pass 2)
- [ ] First /dream compactor → 2026-06-01 ([[Goals#M-001]])
- [ ] First runbook re-verification batch → 2026-08-13 ([[Goals#M-002]])

---

## Quality Checks (Outcome Rubric)

> [!success] Self-evaluation
> - [x] `npm run memory:check` → 0/0 on 42 files
> - [x] `git check-ignore -v` confirms binaries blocked, configs tracked, secrets blocked
> - [x] No `-H "Cookie: $X"` or `-H "Authorization: Bearer $X"` patterns remain in `09_Runbooks/`
> - [x] First real doc in `02_API_Docs/` references actual source code (api-client.ts)
> - [x] First real doc in `03_Reusable_Components/` references actual source code (api-client.ts:14-54)
> - [x] Both new docs have `source` + `confidence` + `last-verified` (truth-maintenance schema)
> - [x] Session log written (this file) — auto-log rule satisfied

---

## Commit Commands

> [!important] Cascade does not auto-commit on this repo
> Per user preference (root `AGENTS.md` § Git Workflow Preference): "push completed fixes directly to `main` only." But `git commit/push` is mutating, so the commands are presented here for user execution.

### One-shot commit

```powershell
cd C:\Users\Server\Desktop\SPX

# Final verify
npm run memory:check
# → ✅ Vault is healthy — no issues found.

# See what's about to ship
git status
git diff --stat

# Stage everything
git add .gitignore AGENTS.md package.json
git add memory/ scripts/ .windsurf/workflows/

# Commit + push (production server auto-pulls and rebuilds Docker)
git commit -m "feat: memory vault production-grade (awakening stack + truth-maintenance + secret-safe runbooks + first API/component docs)"
git push origin main
```

### Cleaner two-commit history (preferred)

```powershell
# Commit 1 — vault content + workflows
git add memory/ .windsurf/workflows/ AGENTS.md
git commit -m "feat: memory vault with awakening stack, runbooks, API/component docs"

# Commit 2 — tooling (linter + .gitignore + npm script)
git add .gitignore package.json scripts/memory-check.mjs
git commit -m "feat: add memory-check vault linter + tighten .obsidian gitignore"

git push origin main
```

> [!note] Production impact
> Docker auto-pull will trigger on push to main. **No code paths changed** — only `package.json` (added `memory:check` script, no new runtime deps), `.gitignore`, docs, and the linter script under `scripts/` (not in build output). `npm ci && npm run build` should succeed identically. **Zero production risk.**

---

## References

- Previous: [[2026-05-13-Vault-Production-Hardening]] · [[2026-05-13-Vault-Hardening-Pass-2]]
- New docs: [[Component-Retry-With-Backoff]] · [[API-Bidding-Endpoints]]
- Hardened runbooks: [[Runbook-Auto-Accept-Debug]] · [[Runbook-Notify-Failure]]
- Linter: `scripts/memory-check.mjs`
- Source code grounding: `src/services/api-client.ts`
- Active goals: [[Goals#G-001]] · [[Goals#M-001]] · [[Goals#M-002]]
