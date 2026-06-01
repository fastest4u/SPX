---
name: spx-memory-verify
description: Verify SPX Memory Vault health using project-memory MCP tools. Use when the user invokes `$spx-memory-verify`, asks for memory verify, asks whether memory is healthy, or after memory/vault edits.
---

# /memory-verify - MCP Memory Health Gate

Run Memory Vault verification through project-memory MCP tools, not shell memory scripts.

## When To Run

- After creating or editing memory notes.
- After `$spx-dream` or compaction work.
- When asked whether memory is healthy.
- Before claiming vault health in an awaken report.

## MCP Steps

1. Call `memory_verifyVault` with `includeWarnings: true`.
2. If individual notes changed, call `memory_verifyNote` for each important path.
3. If source-backed factual claims changed, call `memory_verifySourceTruth`.
4. If the task involved links, call `memory_findBrokenLinks`.
5. If the task involved stale facts, call `memory_checkStaleness`.
6. If the index looks stale, call `memory_reindex`, then repeat the relevant verification.

## Output

Report pass/fail first:

```text
Memory Vault Health: pass/fail
- Files scanned: <N>
- Score/grade: <score>/<grade>
- Errors: <N>
- Warnings: <N>
- Targeted note checks: <summary>
```

## Rules

- Do not use removed npm memory scripts; use project-memory MCP verification tools.
- Do not claim "memory is healthy" without a fresh MCP verification result.
- Fix errors before calling the task complete; summarize warnings honestly.
