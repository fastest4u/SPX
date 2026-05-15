---
title: Runbook - Notification Failure
type: runbook
status: active
last-verified: 2026-05-13
verified-by: codex
source: file:src/services/notifier.ts + file:src/services/line-bot.ts + file:src/services/notify-controller.ts
confidence: high
severity-when-applies: medium
related-adrs:
  - [[ADR-001-Dual-Storage-Notify-Rules]]
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

# Runbook - Notification Failure

> [!abstract] Use this when
> Discord, LINE OA, or LINEJS notifications stop arriving, while the poller still sees matching rules or auto-accept events.

---

## Sensitive Values

> [!danger] Never print secret values
> `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, LINEJS target IDs, `DISCORD_WEBHOOK_URL`, and `COOKIE` are credentials or sensitive routing values. Verify presence and length only.

Current notification channels:

- LINE Official Account: `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_USER_ID`
- Discord: `DISCORD_WEBHOOK_URL`
- LINEJS: `LINEJS_TEST_ENABLED=true` plus target IDs

---

## Fast Triage

Check current settings from the Web UI first:

- Settings -> API & Polling for upstream session values.
- Settings -> Notifications for LINE OA and Discord.
- Settings -> LINE Bot for LINEJS QR login and target routing.

Then use the dashboard notification test:

```text
/notifications -> Preview -> Send Test
```

Backend route: `POST /api/notifications/test`

---

## Required State

- At least one channel configured:
  - LINE OA token + user/group ID
  - Discord webhook URL
  - LINEJS enabled with target ID
- Rule-match-only job notifications are disabled in current source.
- For auto-accept result notifications, `AUTO_ACCEPT_ENABLED=true` and a matching enabled rule is required.

---

## Read-Only Checks

Use DB-backed settings when production HTTP/DB mode is active:

```sql
SELECT setting_key,
       CASE WHEN setting_value = '' THEN 'MISSING' ELSE CONCAT('SET (', CHAR_LENGTH(setting_value), ' chars)') END AS status
FROM app_settings
WHERE setting_key IN (
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_USER_ID',
  'LINEJS_TEST_ENABLED',
  'LINEJS_TEST_TARGET_ID',
  'LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS',
  'LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE',
  'DISCORD_WEBHOOK_URL'
)
ORDER BY setting_key;
```

Check rules:

```sql
SELECT id, name, enabled, fulfilled, auto_accept, auto_accepted, need
FROM notify_rules
ORDER BY updated_at DESC
LIMIT 20;
```

Check auto-accept history:

```sql
SELECT rule_name, booking_id, accepted_count, status, created_at
FROM auto_accept_history
ORDER BY created_at DESC
LIMIT 20;
```

---

## Channel-Specific Checks

### Discord

Symptoms:

- HTTP 204 or 200 means webhook accepted the message.
- HTTP 404 means webhook deleted or wrong URL.
- HTTP 429 means rate-limited.

Use the dashboard test first so the webhook stays secret in app settings.

### LINE Official Account

Symptoms:

- HTTP 200 means push accepted.
- HTTP 401 means channel access token invalid/revoked.
- HTTP 400 often means wrong target ID or payload shape.
- Quota issues appear through `/line-quota` and dashboard quota UI.

Source: `src/services/notifier.ts`.

### LINEJS

Symptoms:

- QR login required: dashboard shows QR/pincode.
- E2EE send fails: service falls back to plain text for known E2EE key errors.
- Missing target ID: notification route cannot pick destination.

Source: `src/services/line-bot.ts`.

---

## Common Causes

| Symptom | Likely cause | Fix |
|---|---|---|
| Preview works but test sends nothing | No configured channel | Add LINE OA, Discord, or LINEJS settings. |
| Discord 404 | Deleted webhook | Create new webhook and update Settings. |
| Discord 429 | Too many messages | Use `NOTIFY_MODE=batch` or reduce duplicate rules. |
| LINE OA 401 | Token revoked | Issue new channel access token and update Settings. |
| LINE OA 400 | Wrong target or payload | Verify `LINE_USER_ID` or group ID. |
| LINEJS asks for QR | Auth token missing/expired | Use LINE Bot page to scan QR. |
| Auto-accept result missing | Rule did not match or accept failed | Check [[Runbook-Auto-Accept-Debug]]. |

---

## Notify Mode

| Mode | Behavior |
|---|---|
| `batch` | One notification per poll batch of matches. |
| `each` | One notification per matched trip. |

Auto-accept result notifications are per event and do not depend on `NOTIFY_MODE`.

---

## Related

- [[API-Internal-HTTP]]
- [[API-SSE-Events]]
- [[Runbook-Auto-Accept-Debug]]
- [[Component-Dual-Storage-Notify-Rules]]
- [[SPX-System-Map]]
