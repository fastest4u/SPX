---
title: Runbook — Auto-Accept Not Firing
type: runbook
status: active
last-verified: 2026-05-13
verified-by: human
source: file:src/controllers/poller.ts + ADR-001-Dual-Storage-Notify-Rules
confidence: high
severity-when-applies: high
related-adrs: [[ADR-001-Dual-Storage-Notify-Rules]]
created: 2026-05-13
updated: 2026-05-13
aliases:
  - Runbook-Auto-Accept-Debug
  - Auto-Accept Runbook
tags:
  - runbook
  - project/spx
  - area/auto-accept
  - topic/notify-rules
---

# Runbook — Auto-Accept Not Firing

## Symptoms

- A booking request matches an enabled rule with `auto_accept: true`
- Discord/LINE shows a "match found" notification but no "auto-accepted" event
- `auto_accept_history` table has no row for the request
- Or: notification missing entirely

## Pre-Flight Check

> [!note] `AUTO_ACCEPT_ENABLED` is a flag (not a secret), but use the same redacted pattern out of habit.

```bash
# 1. Verify env enables auto-accept (prints SET/MISSING, not the value).
ssh root@45.83.207.139 'docker exec spx-app sh -c "
val=$(printenv AUTO_ACCEPT_ENABLED)
echo \"AUTO_ACCEPT_ENABLED: ${val:-MISSING}\"
"'
# Expect: AUTO_ACCEPT_ENABLED: true

# 2. Verify DB is reachable
npm run db:test
```

## Procedure

### 1. Confirm rule has correct flags

```sql
SELECT id, name, enabled, fulfilled, auto_accept, auto_accepted, origins, destinations, vehicle_types
FROM notify_rules
WHERE id = '<rule-id>';
```

**Check:**
- `enabled = 1` (else rule is paused)
- `auto_accept = 1` (else only notify, don't accept)
- `auto_accepted = 0` (if 1, rule fired but didn't re-fire — see § Rule already accepted)
- `origins`, `destinations`, `vehicle_types` arrays match the booking's actual values

### 2. Inspect the booking request

```sql
SELECT * FROM spx_booking_history
WHERE booking_id = '<id>'
ORDER BY id DESC LIMIT 1;
```

**Check:**
- `origin`, `destination`, `vehicle_type` exactly match rule arrays (case-sensitive)
- `acceptance_status` = `'pending'` (else booking already handled)

### 3. Check application logs

```bash
docker compose logs --tail=200 app | grep -i "auto.accept\|notify-rule\|match"
```

**Look for:**
- `[auto-accept] rule X matched booking Y`
- `[auto-accept] calling accept endpoint`
- HTTP error from `booking/bidding/request/accept`
- `[notify-rules] rule already auto-accepted, skipping`

### 4. Trace via Web UI

1. Open the SPX Web UI (HTTP_ENABLED=true)
2. Navigate to **Rules** page → find the rule
3. Check the rule's recent matches list — does the booking show?
4. Navigate to **Auto-Accept History** page → does it show the attempt?

### 5. Manual test (carefully)

> [!danger] Do not pass secrets on the curl command line
> `-H "Cookie: $COOKIE"` expands the secret into **process argv**, where it leaks via `ps aux`, `/proc/<pid>/cmdline`, accounting/audit logs, and parent-shell history. Use a temp header file with `chmod 600` and `curl --header @file`.

**Pattern: header file with chmod 600 (run inside container so secrets never leave it):**

```bash
ssh root@45.83.207.139 'docker exec spx-app sh -c "
set -eu
# 1. Write headers to a 600-perm file in tmpfs (no disk persistence on /tmp under tmpfs)
hdr=$(mktemp)
chmod 600 \"$hdr\"
trap \"rm -f \\\"$hdr\\\"\" EXIT INT TERM

printf \"Cookie: %s\n\" \"$COOKIE\" >> \"$hdr\"
printf \"Authorization: Bearer %s\n\" \"$JWT\" >> \"$hdr\"

# 2. curl reads headers from file — never appears in argv
curl -s -o /dev/null -w \"accept HTTP %{http_code}\n\" \
  -X POST \"http://localhost:3000/api/booking/<booking-id>/accept\" \
  -H @\"$hdr\"
# trap deletes the header file even if curl fails
"'
# Expected: accept HTTP 200 (success) or 4xx with code mapped to common-causes table below
```

> [!tip] Why `-H @file` works
> `curl` supports reading headers from a file with `@filename`. The secret is bytes-on-disk briefly, then the trap deletes it. `argv` only ever sees the `@filename` reference.

If manual accept returns 200 → poller-side bug (rule eval / DB write logic)
If manual accept returns 401 → API/auth issue (see [[Runbook-API-Session-Expired]])
If manual accept returns 409 or another conflict-style error → treat it as provider-specific duplicate/already-handled behavior and inspect the returned body/message before taking action.

## Verify (After Fix)

- [ ] `auto_accept_history` shows row with `status: success`
- [ ] Discord/LINE shows "auto-accepted" notification
- [ ] Booking's `acceptance_status` changed to `accepted`
- [ ] Rule's `auto_accepted = 1` if single-shot, else unchanged

## Common Causes

| Symptom | Likely Cause | Action |
|---|---|---|
| Rule never matches | Case mismatch in origin/destination | Lowercase comparison? Check `notify-rules.ts` |
| Match found, no accept call | `auto_accept = 0` in DB | Update via Web UI or SQL |
| Accept call fails 401 | Session expired | [[Runbook-API-Session-Expired]] |
| Accept call fails 409 / conflict-like response | Provider may consider the request already handled | Inspect response body/message, then check `auto_accept_history` and provider UI |
| Notification missing | `NOTIFY_ENABLED=false` | Check `.env` |
| `notify-rules.json` out of sync with DB | Dual-storage migration issue | See [[ADR-001-Dual-Storage-Notify-Rules]] |

### Rule already accepted

If `auto_accepted = 1`, the rule was a **single-shot** rule that already fired once. To re-arm:

```sql
UPDATE notify_rules SET auto_accepted = 0 WHERE id = '<rule-id>';
```

Or via Web UI: edit the rule → toggle "Reset auto-accept state".

## Rollback

If auto-accept caused wrong booking to be accepted:

1. Cannot un-accept via API (provider doesn't allow).
2. Contact the booking agency directly.
3. Disable the rule: `UPDATE notify_rules SET enabled = 0 WHERE id = '<rule-id>';`
4. Write a `08_Mistakes/` entry documenting the false-positive.

## References

- [[ADR-001-Dual-Storage-Notify-Rules]] — storage strategy
- `src/controllers/poller.ts` — auto-accept flow
- `src/services/notifier.ts` — notification dispatch
- `src/services/notify-rules.ts` — rule evaluation

## Changelog

- **2026-05-13** — Initial version.
