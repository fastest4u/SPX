---
title: Codex Project Memory Tool Native Auto Protocol
type: insight
derived-from:
  - AGENTS.md
  - .agents/skills/spx-session-start/SKILL.md
  - .agents/skills/spx-session-end/SKILL.md
  - .agents/skills/spx-memory-verify/SKILL.md
  - .agents/skills/spx-self-check/SKILL.md
  - .agents/skills/spx-dream/SKILL.md
  - .agents/skills/spx-awaken/SKILL.md
  - 05_Agent_Session_Logs/2026-06-01-Codex-No-Hook-Memory-Lifecycle.md
confidence: high
status: active
created: 2026-06-01
updated: 2026-06-01
tags:
  - insight
  - project/spx
  - topic/memory-vault
  - topic/agent-orchestration
  - topic/tooling
---
Codex should treat project-memory MCP tools as the primary memory interface in SPX. Hooks and npm memory scripts are not the default lifecycle driver. Start meaningful work with memory_sessionStart, memory_contextPack, and memory_followUpRadar; use memory_selfCheck before risky work; auto-select targeted retrieval, verification, maintenance, and writing tools by task intent; close with memory_sessionEnd. Use memory_verifyVault and targeted MCP validators for memory verification unless the user explicitly requests script or CI parity.
