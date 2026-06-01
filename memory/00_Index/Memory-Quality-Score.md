---
title: Memory Quality Score
type: reference
status: superseded
last-verified: 2026-06-01
verified-by: codex
source: project-memory MCP tools
confidence: high
created: 2026-05-13
updated: 2026-06-01
superseded-by:
  - 07_Insights/codex-project-memory-tool-native-auto-protocol.md
tags:
  - reference
  - meta
  - project/spx
  - topic/memory-vault
  - topic/verification
aliases:
  - Memory Score
  - Vault Quality Score
---

# Memory Quality Score

> [!abstract] Current status
> The old npm score script has been removed. Memory quality is now checked through project-memory MCP tools.

## Current MCP Signals

Use:

- `memory_verifyVault` for whole-vault score, grade, errors, warnings, and issue list.
- `memory_verifyNote` for edited-note structure.
- `memory_verifySourceTruth` for source-backed claim checks.
- `memory_findBrokenLinks` for link integrity.
- `memory_checkStaleness` for stale claims or stale verification dates.
- `memory_lifecycleStatus` for session lifecycle quality.
- `memory_followUpRadar` for open follow-up debt.
- `memory_findDuplicates` for overlapping notes.

## Interpreting Results

- Errors must be fixed before calling memory work complete.
- Warnings should be summarized honestly and either fixed or carried as follow-ups.
- Template-related warnings under `99_Templates/` may be acceptable when they are known placeholders, but they should still be mentioned.

## Related

- [[Memory-Evaluation-Test]]
- [[Vault-Dashboard]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[codex-project-memory-tool-native-auto-protocol]]
