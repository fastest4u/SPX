---
name: spx-self-check
description: Run SPX evidence, risk, and verification checks through project-memory MCP before risky work. Use when the user invokes `$spx-self-check`, asks for self-check, or before production-impacting changes involving src, DB schema, auth, secrets, deploy, Docker, notifications, auto-accept, MCP config, hooks, or runtime settings.
---

# /self-check - MCP Risk Check

This workflow makes Codex check evidence and past mistakes before non-trivial work.

## When To Run

- Before architectural or multi-file changes.
- Before production/deploy/DB/auth/secret/runtime work.
- Before MCP config, hook, agent instruction, or memory tooling changes.
- When the user asks "are you sure?".

## MCP Steps

1. Call `memory_selfCheck` with `{ task: "<description of task>" }`. Note: The MCP tool schema accepts only `{ task: string }`.
2. Check deployment contract mode:
   - Read `deploy/runtime-deployment-contract.json` (e.g. `mode: "legacy"` vs `mode: "protected-a3"`).
   - If in `legacy` mode, ensure any changes maintain fallback compatibility and never enforce Protected A3 requirements (such as strict TLS verify-identity, notification node secret rings, or dedicated secret mounts) on production containers.
3. Call `memory_contextPack` if more evidence is needed.
4. Call `memory_search`, `memory_recent`, or `memory_get` for specific notes surfaced by self-check.
5. Call `memory_lifecycleStatus` if the thread may be missing startup context.
6. Build the verification plan:
   - Memory-only: `memory_verifyVault` plus targeted memory validators.
   - Code-only: repo build/typecheck/test commands from root `AGENTS.md`.
   - Code + memory: both the relevant code gate and MCP memory verification.

## Output

Keep it concise (in Thai if user communicates in Thai):

```text
Self-check:
- Task: <one sentence>
- Contract Mode: legacy | protected-a3
- Risk: low/medium/high
- Confidence: high/medium/low/guess
- Past mistakes to avoid: <N>
- Verification plan: <commands/tools>
```

## Rules

- Do not use removed npm memory scripts for the memory side of self-check.
- Do not fake confidence.
- If self-check surfaces a relevant mistake, read it before editing.
- Respect active deployment contract mode before changing config/runtime.

