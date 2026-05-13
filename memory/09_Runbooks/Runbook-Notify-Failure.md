---
title: Runbook — Discord / LINE Notification Failure
type: runbook
status: active
last-verified: 2026-05-13
verified-by: human
source: file:src/services/notifier.ts
confidence: high
severity-when-applies: medium
related-adrs: []
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbook-Notify-Failure
  - Notification Runbook
tags:
  - runbook
  - project/spx
  - area/notify
  - topic/discord
  - topic/line
---

# Runbook — Discord / LINE Notification Failure

## Symptoms

- Booking matches a rule but no Discord/LINE message arrives
- Auto-accept fires but no notification of the result
- Logs show `[notifier] failed` or HTTP errors from webhook calls

## Pre-Flight Check

> [!danger] Never print secret values
> `LINE_NOTIFY_TOKEN`, `DISCORD_WEBHOOK_URL`, and `COOKIE` are credentials. The checks below confirm **presence + non-empty** without revealing values.

```bash
# Confirm env vars are set on the running container (without printing values).
ssh root@45.83.207.139 'docker exec spx-app sh -c "
for v in NOTIFY_ENABLED NOTIFY_MODE LINE_NOTIFY_TOKEN DISCORD_WEBHOOK_URL; do
  val=$(printenv \"$v\")
  if [ -z \"$val\" ]; then echo \"$v: MISSING\"; else echo \"$v: SET (${#val} chars)\"; fi
done"'
```

Required state:
- `NOTIFY_ENABLED=true`
- At least one of `LINE_NOTIFY_TOKEN`, `DISCORD_WEBHOOK_URL` SET
- `NOTIFY_MODE=batch` or `each` (defaults to `batch`)

## Procedure

### 1. Identify which channel is failing

```bash
docker compose logs --tail=200 app | grep -i "notif\|discord\|line"
```

**Look for the dispatched URLs and HTTP responses:**
- `[notifier] discord -> 200` → working
- `[notifier] discord -> 4xx` → bad webhook URL or rate-limited
- `[notifier] line -> 401` → token revoked
- No log line at all → notifier not invoked (check rule matching first via [[Runbook-Auto-Accept-Debug]])

### 2. Test webhooks manually

> [!warning] Run these **inside the container** so the secret never leaves it
> Do NOT paste the token/URL into your shell history. Use `docker exec` with the env var already inside the container, and **drop verbose output**.

**Discord (status code only, body discarded):**
```bash
ssh root@45.83.207.139 'docker exec spx-app sh -c "
curl -s -o /dev/null -w \"discord HTTP %{http_code}\n\" \
  -X POST \"$DISCORD_WEBHOOK_URL\" \
  -H \"Content-Type: application/json\" \
  -d \"{\\\"content\\\":\\\"test from runbook\\\"}\"
"'
# Expected: discord HTTP 204
```

**LINE Notify (status code only, secret via header file — not argv):**
```bash
ssh root@45.83.207.139 'docker exec spx-app sh -c "
set -eu
hdr=$(mktemp); chmod 600 \"$hdr\"
trap \"rm -f \\\"$hdr\\\"\" EXIT INT TERM
printf \"Authorization: Bearer %s\n\" \"$LINE_NOTIFY_TOKEN\" >> \"$hdr\"
curl -s -o /dev/null -w \"line HTTP %{http_code}\n\" \
  -X POST https://notify-api.line.me/api/notify \
  -H @\"$hdr\" \
  -d \"message=test from runbook\"
"'
# Expected: line HTTP 200
```

> [!note] Discord webhook pattern is different
> Discord uses a **secret URL** rather than a bearer header — there's no clean `@file` for URLs. The Discord call above piggybacks on the env var inside the container. Don't paste the URL into your shell. Treat it like a token.

> [!tip] If you must inspect the response body for debugging
> Pipe through `sed 's/<TOKEN>/<REDACTED>/g'` or write to a `chmod 600` temp file, then delete. **Never** commit or paste in chat.

### 3. Common HTTP error responses

| Service | Code | Meaning | Action |
|---|---|---|---|
| Discord | 401 | Webhook revoked | Re-create webhook in Discord channel settings |
| Discord | 404 | Webhook deleted | Re-create + update `.env` |
| Discord | 429 | Rate-limited | Switch `NOTIFY_MODE=batch` |
| LINE | 401 | Token revoked | Re-issue token at notify-bot.line.me |
| LINE | 400 | Bad request body | Check `notifier.ts` payload format |

### 4. Update env (via Web UI if available)

Same flow as [[Runbook-API-Session-Expired]] § Step 2 — use Settings page to update token/URL, container auto-restarts.

### 5. Verify

```bash
# Trigger a test notification programmatically
# (use a low-impact rule or wait for next match)
docker compose logs -f app | grep -i notif
```

## Verify (Post-Fix)

- [ ] Test webhook curl returns 200/204
- [ ] Next rule match produces a real Discord/LINE message
- [ ] `notifier.ts` logs `dispatched` for the message
- [ ] Recipients confirm receipt

## NOTIFY_MODE Differences

| Mode | Behavior | When to use |
|---|---|---|
| `batch` (default) | One message per poll cycle, listing all matches | Lots of matches, want compact output |
| `each` | One message per match | Few matches, want detail per booking |

To change → Web UI Settings or edit `.env`, then container auto-restarts.

## Auto-Accept Notification Specifics

When `AUTO_ACCEPT_ENABLED=true`, a second notification is dispatched per auto-accept result. This **does not** depend on `NOTIFY_MODE` and is always per-event.

Check `auto_accept_history` table for what should have been notified:

```sql
SELECT * FROM auto_accept_history ORDER BY id DESC LIMIT 10;
```

## References

- `src/services/notifier.ts` — Discord embeds + LINE message format
- `src/services/notify-rules.ts` — rule evaluation
- Root `AGENTS.md` → Runtime Env → Notification section

## Changelog

- **2026-05-13** — Initial version.
