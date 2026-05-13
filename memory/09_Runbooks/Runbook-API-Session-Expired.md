---
title: Runbook — Bidding API Session Expired / 401 Loop
type: runbook
status: active
last-verified: 2026-05-13
verified-by: human
source: file:src/services/api-client.ts
confidence: high
severity-when-applies: critical
related-adrs: []
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbook-API-Session-Expired
  - 401 Loop
tags:
  - runbook
  - project/spx
  - area/api
  - topic/auth
---

# Runbook — Bidding API Session Expired

## Symptoms

- Poller logs `[api-client] session expired retcode=...`
- `GET /api/booking/bidding/list` returns 401 repeatedly after retries
- No new bookings appear in DB for > 2 poll intervals
- Discord/LINE silent for an extended period

## Pre-Flight Check

> [!danger] Never print secret values to terminal or logs
> Treat `COOKIE`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, LINEJS target IDs, and `DISCORD_WEBHOOK_URL` as sensitive. The checks below verify **presence and length** without printing the value.

```bash
# Confirm required env vars are SET (without revealing values).
# Prints e.g. "COOKIE: SET (1842 chars)" or "COOKIE: MISSING".
ssh root@45.83.207.139 'docker exec spx-app sh -c "
for v in COOKIE API_URL DEVICE_ID; do
  val=$(printenv \"$v\")
  if [ -z \"$val\" ]; then echo \"$v: MISSING\"; else echo \"$v: SET (${#val} chars)\"; fi
done"'
```

## Procedure

### 1. Refresh cookie/session

The bidding provider's session is stored in env var `COOKIE`. To refresh:

1. Open the bidding provider's web UI in a browser
2. Log in with the working account
3. Open DevTools → Network tab → trigger any list fetch
4. Find the request to `booking/bidding/list`
5. Copy the **full `Cookie:` header value**

### 2. Update `.env` via Web UI (preferred)

> [!tip] The Web UI has a Settings page
> Navigate to `https://<server>/settings` → paste new cookie → save.
> This calls `SettingsController` which overwrites `.env` and triggers `process.exit(0)`.
> Docker auto-restart picks up the new value.

### 3. Update `.env` manually (fallback)

```bash
ssh root@45.83.207.139
cd /root/SPX
vi .env  # edit COOKIE=... line
docker compose restart app
```

### 4. Verify

```bash
docker compose logs --tail=50 app | grep -E "(session|cookie|fetched|polled)"
```

Look for first successful poll:
```
[api-client] fetched N bookings
```

## Verify (Post-Fix)

- [ ] Logs show successful polls every `POLL_INTERVAL_MS`
- [ ] DB has new rows in `spx_booking_history` since restart
- [ ] No 401 in logs for 5 minutes

## Common Failures

| Symptom | Cause | Fix |
|---|---|---|
| Cookie copied but still 401 | Account logged in on multiple devices | Re-login to invalidate other sessions, then re-copy |
| Session refreshes but bookings missing | `API_URL` outdated (provider changed endpoint) | Re-check provider docs, update `.env` |
| Multiple `DEVICE_ID` errors | Cookie was issued to a different device | Match `DEVICE_ID` to the one in the new browser session |
| Settings UI doesn't save | `SettingsController` write failed (perms?) | Check container has write access to `/root/SPX/.env` |

## Long-term Mitigation

> [!warning] Open issue — auto-refresh strategy
> Currently sessions must be refreshed manually. Possible mitigations:
> - **Headless browser** to auto-login + extract cookie (high effort)
> - **Alert on first 401** via Discord webhook (low effort)
> - **Multi-account fallback** — rotate accounts (medium effort)
>
> Promote to ADR if implementing.

## References

- `src/services/api-client.ts` — retry + session-expired detection
- `src/controllers/settings-controller.ts` — Web UI env writer
- Root `AGENTS.md` → Runtime Env section (lists `COOKIE`, `DEVICE_ID`)

## Changelog

- **2026-05-13** — Initial version.
