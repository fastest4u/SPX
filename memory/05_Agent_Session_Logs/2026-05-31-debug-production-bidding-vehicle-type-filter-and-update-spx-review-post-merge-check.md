---
title: 2026-05-31 - Debug production BIDDING_VEHICLE_TYPE filter and update spx-review post-merge check
type: session-log
session-date: 2026-05-31
agent: codex
duration-minutes: 18
outcomes:
  - "Verified production server /root/SPX is still at commit 839e3cc (#37), while local/main has 76ebbec (#38) with BIDDING_VEHICLE_TYPE filter."
  - Verified running container spx-app-1 has no BIDDING_VEHICLE_TYPE env value and its dist/app.js contains zero BIDDING_VEHICLE_TYPE string occurrences.
  - "Queried production DB read-only: app_settings has no BIDDING_VEHICLE_TYPE, 4WH-4ล้อ has 71,881 history rows and fresh rows as late as 2026-05-31T04:05:34Z."
  - "Confirmed SPX API accepts vehicle_type field with current DB-backed cookie; without vehicle_type returned current data, with vehicle_type 13 returned zero current rows in the sample."
  - Updated .agents/skills/spx-review/SKILL.md with a mandatory read-only post-merge production check and explicit deploy/restart gate.
created: 2026-05-31
updated: 2026-05-31
tags:
  - session-log
  - project/spx
---
# 2026-05-31 - Debug production BIDDING_VEHICLE_TYPE filter and update spx-review post-merge check

## TL;DR
- Verified production server /root/SPX is still at commit 839e3cc (#37), while local/main has 76ebbec (#38) with BIDDING_VEHICLE_TYPE filter.
- Verified running container spx-app-1 has no BIDDING_VEHICLE_TYPE env value and its dist/app.js contains zero BIDDING_VEHICLE_TYPE string occurrences.
- Queried production DB read-only: app_settings has no BIDDING_VEHICLE_TYPE, 4WH-4ล้อ has 71,881 history rows and fresh rows as late as 2026-05-31T04:05:34Z.
- Confirmed SPX API accepts vehicle_type field with current DB-backed cookie; without vehicle_type returned current data, with vehicle_type 13 returned zero current rows in the sample.
- Updated .agents/skills/spx-review/SKILL.md with a mandatory read-only post-merge production check and explicit deploy/restart gate.

## Goal
Debug production BIDDING_VEHICLE_TYPE filter and update spx-review post-merge check

## What Was Done
- Verified production server /root/SPX is still at commit 839e3cc (#37), while local/main has 76ebbec (#38) with BIDDING_VEHICLE_TYPE filter.
- Verified running container spx-app-1 has no BIDDING_VEHICLE_TYPE env value and its dist/app.js contains zero BIDDING_VEHICLE_TYPE string occurrences.
- Queried production DB read-only: app_settings has no BIDDING_VEHICLE_TYPE, 4WH-4ล้อ has 71,881 history rows and fresh rows as late as 2026-05-31T04:05:34Z.
- Confirmed SPX API accepts vehicle_type field with current DB-backed cookie; without vehicle_type returned current data, with vehicle_type 13 returned zero current rows in the sample.
- Updated .agents/skills/spx-review/SKILL.md with a mandatory read-only post-merge production check and explicit deploy/restart gate.

## Files Touched
- .agents/skills/spx-review/SKILL.md

## Decisions Made
- None

## Open Follow-ups
- [ ] Production still needs explicit deploy/rebuild/restart from commit 76ebbec before BIDDING_VEHICLE_TYPE filter can affect live polling.
- [ ] After deployment, re-check server HEAD/container bundle/runtime key and verify no new 4WH rows are inserted after deployment time.
- [ ] Decide whether BIDDING_VEHICLE_TYPE=13 is the intended vehicle type, because the current SPX API sample with vehicle_type=13 returned zero rows.

## References
- .agents/skills/spx-review/SKILL.md

## Verification
Ran SSH read-only checks against root@45.83.207.139; docker inspect/exec checks for spx-app-1; read-only MySQL aggregate/sample queries via node inside container without printing secrets; read-only SPX API payload test without printing credentials; spx-review SKILL.md frontmatter manual check passed; git diff --check for SKILL.md passed with only CRLF warning.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
