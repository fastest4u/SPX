---
title: Mistake-001 — Wrong env var name for GitHub MCP
type: mistake
severity: medium
status: resolved
occurred-date: 2026-05-13
resolved-date: 2026-05-13
created: 2026-05-13
updated: 2026-05-13
agent: cascade
area: tooling/mcp
confidence: high
aliases:
  - Mistake-001
  - M-001
  - GitHub MCP env var
tags:
  - mistake
  - topic/mcp
  - topic/github
  - project/spx
  - severity/medium
---

# Mistake-001 — Wrong env var name for GitHub MCP

> [!abstract] One-liner
> Set `github_token` (lowercase) as env var, but the GitHub MCP server requires `GITHUB_PERSONAL_ACCESS_TOKEN`. Also, env had to be passed via Docker `-e` flag, not the MCP config `env:` block.

---

## What Happened

When configuring GitHub MCP server in Windsurf:

1. Set env var name to `github_token` based on the registry display label.
2. Server kept reporting `GITHUB_PERSONAL_ACCESS_TOKEN not set`.
3. Tried `env:` block in `mcp_config.json` — Docker container didn't receive it.
4. Eventually moved token to Docker `-e` flag in `args[]`.

## Root Cause

Two separate issues stacked:

| Issue | Reality |
|---|---|
| **Env name** | Documentation showed `github_token` (lowercase), but actual server reads `GITHUB_PERSONAL_ACCESS_TOKEN` |
| **Env passing** | MCP config `env:` doesn't always propagate to Docker — must use `-e KEY=VALUE` in `args` |

## Correct Pattern

```json
{
  "io.windsurf/github-mcp-server": {
    "command": "docker",
    "args": [
      "run", "-i", "--rm",
      "-e", "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx",
      "ghcr.io/github/github-mcp-server"
    ]
  }
}
```

**NOT this:**

```json
{
  "io.windsurf/github-mcp-server": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
    "env": { "github_token": "ghp_xxx" }  // wrong name AND wrong passing
  }
}
```

## Time Lost

~10 minutes of trial-and-error.

## How AI Should Avoid This

> [!tip] Checklist for ANY MCP server with Docker
> 1. **Run the docker image manually first** with `--help` to see required env vars.
> 2. **Match case exactly** — env vars are case-sensitive on Linux.
> 3. **Pass env via `-e` flag in `args`** when the MCP server runs in Docker.
> 4. **Test with `mcp2_get_me` or equivalent** before trusting the config.

## How To Detect Recurrence

If you see `<ENV_VAR_NAME> not set` errors:

1. Run the image manually: `docker run --rm <image> --help`
2. Read its env-var section
3. Check exact casing
4. Verify it's passed via `-e` in MCP args

## Related

- ADR / decision affected: none
- Session log: [[2026-05-13-Setup-MCP-Servers]]
- Similar pattern to watch: any Docker-based MCP (Playwright, custom)
