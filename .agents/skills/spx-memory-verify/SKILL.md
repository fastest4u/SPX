---
name: spx-memory-verify
description: Verify SPX Project Memory V2 store health using project-memory MCP tools and operator CLI. Use when the user invokes `$spx-memory-verify`, asks for memory verify, asks whether memory is healthy, or after memory/governance updates.
---

# /memory-verify - MCP Memory V2 Health Gate

Run Project Memory V2 verification through project-memory V2 MCP tools (`memory-v2/`), not legacy shell memory scripts.

## When To Run

- After creating or updating governed memory records (ADRs, insights, mistakes, session logs).
- After `$spx-dream` or governed lifecycle transitions (`memory_promote`, `memory_supersede`, `memory_retract`, `memory_expire`, `memory_forgetEvidence`).
- When asked whether memory is healthy.
- Before claiming store health in an awaken report.

## MCP Steps

1. Call `memory_v2Status` (`{}`) to confirm `mode: "active"`, `productionReady: true`, and `projectId: "310f00ba-ff0f-47bc-9430-a3a838647462"`.
2. Call `memory_verifyVault` (`{}`).
3. If individual governed records changed, call `memory_verifyNote` for each record.
4. If source-backed factual claims changed, call `memory_verifySourceTruth`.
5. Call `memory_findDuplicates` and `memory_checkStaleness` when checking content hygiene.
6. If projections need rebuilding or V1 archive integrity needs operator verification, use the V2 operator CLI:
   - `node "C:\Users\Server\Desktop\Awakened-AI-System\dist\v2-admin.js" rebuild-projections --project-root "C:\Users\Server\Desktop\SPX" --v2-vault-root "C:\Users\Server\Desktop\SPX\memory-v2" --v1-archive-root "C:\Users\Server\Desktop\SPX\memory"`
   - `node "C:\Users\Server\Desktop\Awakened-AI-System\dist\v2-admin.js" verify-v1-archive --project-root "C:\Users\Server\Desktop\SPX" --v2-vault-root "C:\Users\Server\Desktop\SPX\memory-v2" --v1-archive-root "C:\Users\Server\Desktop\SPX\memory"`

## Output

Report pass/fail first:

```text
Memory V2 Store Health: pass/fail
- Mode / Production Ready: active / true
- Vault Verification: <status>
- Targeted checks: <summary>
```

## Rules

- Do not use removed npm memory scripts; use project-memory V2 MCP verification tools.
- Do not claim "memory is healthy" without a fresh MCP verification result.
- Fix errors before calling the task complete; summarize warnings honestly.
