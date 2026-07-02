---
title: Secret-Safe Operational Patterns
type: insight
status: stable
derived-from:
  - [[2026-05-13-Setup-MCP-Servers]]
  - [[2026-05-13-Vault-Hardening-Pass-2]]
  - [[2026-05-13-Vault-Hardening-Pass-3]]
confidence: high
created: 2026-05-13
updated: 2026-07-02
tags:
  - insight
  - project/spx
  - topic/security
  - topic/runbooks
aliases:
  - Secret Safe Patterns
  - Operational Security
---

# Secret-Safe Operational Patterns

> [!abstract] Insight
> Secrets (tokens, cookies, passwords) leak through channels that are invisible during normal development: process args, shell history, and Docker overlay. Safe operational patterns must be documented explicitly because the unsafe pattern is always the natural one to write.

---

## Leak Channels

| Channel | How it leaks | When it happens |
|---|---|---|
| `argv` | `ps aux`, `/proc/<pid>/cmdline` | `-H "Cookie: $X"` in curl |
| Shell history | `.bash_history`, `.zsh_history` | Commands with env var expansion |
| Docker overlay | `docker exec` logs | `env` inside container |
| Git | Committed `.env` files | `git add .` without `.gitignore` |
| Terminal scrollback | IDE/console output | `echo $SECRET` for debugging |

---

## Safe Patterns

### 1. Header File + Trap (curl)

```bash
hdr=$(mktemp); chmod 600 "$hdr"
trap "rm -f \"$hdr\"" EXIT INT TERM
printf "Cookie: %s\n" "$COOKIE" >> "$hdr"
curl -H @"$hdr" ...
```

- `argv` only contains `@/tmp/tmp.XXXXXX`
- `chmod 600` restricts to current uid
- `trap` deletes file even on SIGINT/SIGTERM
- Run inside container to avoid host shell history

### 2. Container-Side Commands

```bash
# GOOD — confirms presence/length without printing secret values
docker compose exec -T notifier sh -c '
for v in COOKIE LINE_CHANNEL_ACCESS_TOKEN DISCORD_WEBHOOK_URL; do
  val=$(printenv "$v")
  if [ -z "$val" ]; then echo "$v: MISSING"; else echo "$v: SET (${#val} chars)"; fi
done'

# BAD — prints secret values into terminal scrollback/logs
docker compose exec -T notifier env | grep COOKIE
```

### 3. Docker `-e` Over Config `env:`

```bash
# GOOD — OS env is more reliable than tool config on Windows
docker run -e GITHUB_TOKEN=$TOKEN ...

# BAD — tool config may not pass env through on all platforms
```

### 4. MySQL Password Handling

```bash
# GOOD — interactive prompt
mysql -h $DB_HOST -u $DB_USER -p

# BAD — password visible in ps aux
mysql -h $DB_HOST -u $DB_USER -p$PASSWORD
```

Prefer `~/.my.cnf` with `chmod 600` for scripted access.

---

## Why This Matters

> [!warning] The unsafe pattern is the natural one
> A `-H "Cookie: $X"` line looks safe in a script. The leak only manifests in `/proc/<pid>/cmdline` and `ps aux` snapshots, neither of which appear in normal output. Documenting the safer pattern explicitly is necessary because developers write the unsafe version by instinct.

---

## Design Rule

When writing operational procedures that touch secrets:

1. Ask: "Does this touch a secret?" → If yes, apply all rules below.
2. Prefer container-side execution over host-side.
3. Use file-based headers (`-H @file`) over inline headers.
4. Always `chmod 600` temp files.
5. Always `trap` cleanup.
6. Never print secret values in output — use presence/length checks instead.

---

## Related

- [[Runbook-API-Session-Expired]]
- [[Runbook-Auto-Accept-Debug]]
- [[Runbook-Notify-Failure]]
- [[Mistake-001-Wrong-Env-Var-Name-GitHub-MCP]]
