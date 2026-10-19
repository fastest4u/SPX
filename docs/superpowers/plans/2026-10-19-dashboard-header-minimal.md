# Dashboard Header Minimal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cluttered Dashboard header status cluster with a single minimal status indicator ("one line, one status") that is truthful for both admin and team users.

**Architecture:** Add a pure `getDashboardSystemStatus()` + `formatPollAge()` to `src/frontend/lib/dashboard-runtime-state.ts` for the admin aggregate view (team view keeps `getDashboardTeamControlState`). A small presentational `StatusIndicator` component renders dot + label + relative age with the detail in a native `title` tooltip. `routes/index.tsx` swaps `statusGroup` for the indicator and moves team enable/disable to the existing `Switch`.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind v4, lucide-react, tsx assertion tests.

**Spec:** In-chat approved design (2026-10-19, bounded path): "หนึ่งบรรทัด หนึ่งสถานะ".

## Global Constraints

- No new API calls; use metrics already returned by `useScopedMetrics()`.
- Freshness boundary stays `DASHBOARD_POLL_FRESHNESS_MS` (120 s); clock skew tolerance stays `DASHBOARD_CLOCK_SKEW_TOLERANCE_MS` (15 s).
- Remove the `Admin Console` badge; no uppercase/tracking status text; no pill border cluster.
- Provider account health is shown only when `healthTone !== 'healthy'` (team view).
- Existing `getDashboardTeamControlState` behavior and tests must not change.
- Frontend style: single quotes, minimal semicolons, 2-space indent.

## Review Focus

- Admin with no metrics yet → must show neutral "กำลังเชื่อมต่อ…", never a red/green claim.
- Metrics snapshot scoped to a team (teamId !== null) shown to admin → neutral, not Live.
- Poll timestamp in the future beyond skew tolerance → treated as unconfirmed, not Live.
- Stale poll (>120 s) → amber "ไม่มีผล poll ใหม่", not green.
- Relative age with negative delta (client clock behind) → "เมื่อสักครู่", never "-3 วินาที".

---

### Task 1: Admin system status + poll age (pure logic)

**Files:**
- Modify: `src/frontend/lib/dashboard-runtime-state.ts`
- Test: `tests/frontend-dashboard-team-control.test.ts`

**Interfaces:**
- Produces:
  - `type DashboardStatusTone = 'live' | 'paused' | 'off' | 'error' | 'unknown'`
  - `type DashboardSystemStatus = { tone: 'live' | 'paused' | 'error' | 'unknown'; label: string; detail: string; lastPollAt: number | null }`
  - `getDashboardSystemStatus({ metrics, nowMs }: { metrics?: DashboardMetricsObservation | null; nowMs: number }): DashboardSystemStatus`
  - `formatPollAge(lastPollAt: number | null, nowMs: number): string | null`

- [ ] **Step 1: Write failing tests** (exact values)
  - no metrics → `{ tone: 'unknown', label: 'กำลังเชื่อมต่อ…', lastPollAt: null }`
  - `teamId: 7` → tone `unknown`
  - `isPaused: true` → `{ tone: 'paused', label: 'พักการ poll' }`
  - `timestamp: null` → `{ tone: 'unknown', label: 'รอผล poll แรก' }`
  - future timestamp beyond skew → tone `unknown`
  - `status: 'session_expired'` → `{ tone: 'error', label: 'Session หมดอายุ' }`
  - timestamp older than 120 s → `{ tone: 'paused', label: 'ไม่มีผล poll ใหม่' }`
  - `status: 'network'` → `{ tone: 'error', label: 'poll ล่าสุดล้มเหลว', detail: 'ผล poll ล่าสุดล้มเหลว (network)' }`
  - `isHealthy: false` → `{ tone: 'error', label: 'ต้องตรวจสอบบัญชี' }`
  - fresh ok → `{ tone: 'live', label: 'ทำงานปกติ', lastPollAt: nowMs - 30_000 }`
  - `formatPollAge(null, now)` → `null`; `-5_000` delta → `'เมื่อสักครู่'`; `1_000` → `'เมื่อสักครู่'`; `30_000` → `'30 วินาทีที่แล้ว'`; `180_000` → `'3 นาทีที่แล้ว'`; `7_200_000` → `'2 ชั่วโมงที่แล้ว'`
- [ ] **Step 2: Run** `npx tsx tests/frontend-dashboard-team-control.test.ts` → FAIL (missing export)
- [ ] **Step 3: Implement** both functions; parse timestamp with same skew rule as `observedPollTimestamp`.
- [ ] **Step 4: Run** test → PASS (existing assertions unchanged)

### Task 2: StatusIndicator component + header wiring

**Files:**
- Create: `src/frontend/components/ui/status-indicator.tsx`
- Modify: `src/frontend/components/ui/switch.tsx` (optional `aria-label`, `title` props)
- Modify: `src/frontend/routes/index.tsx` (header block ~L351-L485)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `StatusIndicator({ tone, label, age, detail, className }: { tone: DashboardStatusTone; label: string; age?: string | null; detail?: string; className?: string })`

- [ ] **Step 1:** Create `StatusIndicator`: `role="status"`, dot (ping animation only for `live`), label `text-sm font-medium`, age `text-muted-foreground`, `title={detail}`.
- [ ] **Step 2:** In `index.tsx`: remove `primaryStatusClassName`, `primaryStatusContent`, `statusGroup`, Admin Console badge; title becomes plain `ภาพรวมระบบ` (team users keep a muted `· ทีม {name}` suffix in subtitle).
- [ ] **Step 3:** Admin → `actions` = `StatusIndicator` (system status) + `จัดการทีม` ghost link. Team user → `StatusIndicator` (team state mapped to Thai labels) + `Switch` (enable/disable) + provider-account button; inline warning text only when `healthTone !== 'healthy'`.
- [ ] **Step 4:** `npm run typecheck` → exit 0; `npx tsx tests/frontend-dashboard-team-control.test.ts` and `npx tsx tests/frontend-rules-datatable.test.ts` → PASS.
- [ ] **Step 5:** `npm run build` → exit 0. Visual check in `npm run dev` (desktop + 390 px mobile).
