---
title: Memory Evaluation Test
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
  - topic/agent-orchestration
aliases:
  - Memory Eval
  - Memory Retrieval Evaluation
---

# Memory Evaluation Test

> [!abstract] Current status
> The old npm memory evaluation scripts have been removed. Codex now uses project-memory MCP retrieval and verification tools directly.

## Current MCP Flow

Use these tools instead of script commands:

- `memory_contextPack` to retrieve task-scoped context and evidence.
- `memory_awaken` to assess project state and next actions.
- `memory_followUpRadar` to surface open follow-ups.
- `memory_verifyVault` to verify whole-vault health.
- `memory_verifyNote` for edited notes.
- `memory_verifySourceTruth` for factual/source-backed claims.
- `memory_lifecycleStatus` to confirm session lifecycle quality.

## Acceptance Questions

Agents should still be able to answer these SPX questions from memory evidence:

- How should an Awakened AI operate in SPX?
- How does the whole SPX runtime work?
- Where are settings stored and how do they apply?
- What should an agent do when the upstream SPX session expires?
- How does auto-accept avoid over-accepting?
- How are notify rules stored across dev and prod?
- How should production schema drift be checked?
- How do we test multi-agent memory acceptance?

## Maintenance

When a new critical operating question appears, update this note and the relevant runbook or insight. Verify through `memory_contextPack`, `memory_awaken`, and `memory_verifyVault`.

## Related

- [[Memory-Quality-Score]]
- [[Vault-Dashboard]]
- [[Runbook-Multi-AI-Memory-Acceptance]]
- [[codex-project-memory-tool-native-auto-protocol]]
