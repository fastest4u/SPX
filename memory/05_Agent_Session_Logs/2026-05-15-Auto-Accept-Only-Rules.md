---
title: "2026-05-15 - Auto-Accept Only Rules"
type: session-log
session-date: 2026-05-15
agent: codex
duration-minutes: 45
outcomes:
  - Disabled normal rule-match job notifications in the poller flow.
  - Made enabled rules behave as auto-accept candidates by default.
  - Removed the UI setting that allowed creating or editing notify-only rules.
  - Updated source-grounded Memory Vault docs for the new behavior.
created: 2026-05-15
updated: 2026-05-15
tags:
  - session-log
  - project/spx
  - topic/auto-accept
  - topic/notify-rules
  - area/frontend
  - area/notify
---

# 2026-05-15 - Auto-Accept Only Rules

> [!abstract] TL;DR
> Changed rule behavior so enabled routes/rules are auto-accept candidates and the normal notify-only job alert path is disabled.

## Goal

Remove the normal job notification mode and make enabled routes use auto-accept behavior instead.

## What Was Done

- [x] Removed the poller call to normal `notifyMatchedRules()` after auto-accept processing.
- [x] Changed active auto-accept rule selection so enabled, unfulfilled rules with `need > 0` are candidates even if old DB rows had `auto_accept = 0`.
- [x] Normalized enabled rules to return/persist `auto_accept: true` for API/UI compatibility.
- [x] Reduced `notifyMatchedRules()` to dry-run/no-op behavior so legacy callers cannot send notify-only job alerts.
- [x] Removed the auto-accept checkbox from create/edit rule dialogs and force-submitted `auto_accept: true`.
- [x] Removed the obsolete LINEJS rule-match target from settings surfaces.
- [x] Updated Memory Vault docs and runbooks that described notify-only rule behavior.

## Files Touched

- `src/controllers/poller.ts`
- `src/services/notify-rules.ts`
- `src/services/notifier.ts`
- `src/config/env.ts`
- `src/services/settings.ts`
- `src/controllers/settings-controller.ts`
- `src/frontend/components/CreateRuleDialog.tsx`
- `src/frontend/components/EditRuleDialog.tsx`
- `src/frontend/components/SettingsLineBotSection.tsx`
- `src/frontend/routes/settings.tsx`
- `src/frontend/types/index.ts`
- `memory/01_Project_Rules/SPX-Project-Rules.md`
- `memory/01_Project_Rules/SPX-System-Map.md`
- `memory/02_API_Docs/API-Internal-HTTP.md`
- `memory/03_Reusable_Components/Component-Dual-Storage-Notify-Rules.md`
- `memory/03_Reusable_Components/Component-Poller-Orchestration.md`
- `memory/09_Runbooks/Runbook-Auto-Accept-Debug.md`
- `memory/09_Runbooks/Runbook-Notify-Failure.md`

## Decisions Made

- Kept `AUTO_ACCEPT_ENABLED` as the global safety gate; enabled rules auto-accept only when global auto-accept is enabled.
- Kept `auto_accept` in the rule schema/API for compatibility with existing DB rows, migrations, and clients.
- Left generic notification channel testing in place because auto-accept success/failure and session-expiry alerts still use the same channels.

## Verification

- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [x] `git diff --check` passed; Git reported line-ending warnings only.

## Confidence Log

| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Normal notify and auto-accept were separate source flows | medium | confirmed in `src/controllers/poller.ts` and `src/services/notifier.ts` | Read the actual orchestration before changing behavior |
| Existing DB rules with `auto_accept = 0` needed compatibility handling | medium | handled by ignoring the flag for active auto-accept matching and normalizing enabled rules to `auto_accept: true` | Behavior changes must account for existing stored rows |

## Open Follow-ups

- None.

## References

- [[Component-Poller-Orchestration]]
- [[Component-Dual-Storage-Notify-Rules]]
- [[Runbook-Auto-Accept-Debug]]
- [[Runbook-Notify-Failure]]
