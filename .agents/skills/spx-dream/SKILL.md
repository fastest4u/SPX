---
name: spx-dream
description: Curate and govern SPX Project Memory V2 records by promoting recurring lessons into verified insights, ADRs, or mistakes and superseding/expiring stale records using project-memory V2 MCP tools. Use when the user invokes `$spx-dream`, asks for dream/compactor, or requests memory governance cleanup.
---

# /dream - MCP Memory V2 Governance & Curation

Use Project Memory V2 governance and verification tools to curate long-running memory without legacy shell scripts or V1 file edits.

## When To Run

- Monthly or after many sessions.
- When agents cite conflicting or stale memory records.
- When the user asks for a memory audit, curation, or governance pass.

## MCP Steps

1. Call `memory_v2Status` and `memory_lifecycleStatus`.
2. Call `memory_contextPack` in `docs` mode for memory governance.
3. Run hygiene and staleness checks:
   - `memory_findDuplicates`
   - `memory_checkStaleness`
   - `memory_verifySourceTruth`
4. Write or promote durable lessons with governed V2 tools:
   - `memory_writeInsight`
   - `memory_writeMistake`
   - `memory_writeADR`
5. Apply governed lifecycle transitions as needed:
   - `memory_promote` (promote `candidate` -> `provisional` / `verified` with verification method & anchor)
   - `memory_supersede` (supersede outdated records or declare/resolve conflicts)
   - `memory_retract` / `memory_expire` (retire invalid or expired records)
   - `memory_forgetEvidence` (cryptographic erasure when required)
6. Call `memory_verifyVault`.
7. Close with `memory_sessionEnd`.

## Rules

- Never edit files in the frozen V1 archive (`memory/`).
- Use `memory_supersede`, `memory_retract`, or `memory_expire` for record lifecycle transitions.
- Preserve provenance and verification anchors when promoting records.
