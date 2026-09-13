import assert from "node:assert/strict";

import {
  DASHBOARD_POLL_FRESHNESS_MS,
  getDashboardSessionRecovery,
  getDashboardTeamControlState,
} from "../src/frontend/routes/index.tsx";
import type { AuthUser, MetricsSnapshot, Team } from "../src/frontend/types/index.ts";

const nowMs = Date.parse("2026-09-12T12:00:00.000Z");

const team: Team = {
  id: 7,
  name: "PTWL",
  enabled: true,
  hasSpxCookie: true,
  hasSpxDeviceId: true,
  hasLineGroupId: true,
  hasAutoAcceptSuccessLineGroupId: true,
  hasAutoAcceptFailureLineGroupId: true,
  spxCookiePreview: "********okie",
  spxDeviceIdPreview: "********vice",
  lineGroupIdPreview: "********line",
  autoAcceptSuccessLineGroupIdPreview: "********good",
  autoAcceptFailureLineGroupIdPreview: "********fail",
  runtimeStatus: "running",
  usersCount: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const user: AuthUser = {
  id: 11,
  username: "ptwl-user",
  role: "user",
  teamId: team.id,
};

const admin: AuthUser = {
  id: 1,
  username: "admin",
  role: "admin",
  teamId: null,
};

function metrics(overrides: {
  teamId?: number | null;
  timestamp?: string | null;
  status?: string | null;
  isPaused?: boolean;
  isHealthy?: boolean;
} = {}): MetricsSnapshot {
  return {
    teamId: overrides.teamId === undefined ? team.id : overrides.teamId,
    uptime: 60,
    startedAt: "2026-09-12T11:00:00.000Z",
    isPaused: overrides.isPaused ?? false,
    lastPoll: {
      timestamp: overrides.timestamp === undefined
        ? new Date(nowMs - 30_000).toISOString()
        : overrides.timestamp,
      status: overrides.status ?? "same",
      latencyMs: 120,
      recordCount: 4,
    },
    polling: {
      totalRequests: 1,
      successCount: 1,
      errorCount: 0,
      successRate: 100,
      latency: { avg: 120, min: 120, max: 120, p50: 120, p95: 120, p99: 120 },
    },
    session: {
      isHealthy: overrides.isHealthy ?? true,
      consecutiveErrors: 0,
      lastSessionWarning: null,
    },
    database: null,
    data: { totalRecordsSeen: 4, changesDetected: 0, tripsInserted: 0, tripsSkipped: 0 },
    autoAccept: { totalAttempts: 0, successCount: 0, failureCount: 0 },
    scheduling: { launched: 0, skippedConcurrency: 0, skippedCooldown: 0 },
    upstream: { requests: 1, connections: 1, reuseRatio: 0 },
    operations: {},
    runtime: {
      activeDetailJobs: 0,
      activeDetailBookings: 0,
      detailConcurrency: 4,
      queuedDetailBookings: 0,
      detailQueuePressure: 0,
      sseClients: 1,
    },
  };
}

assert.equal(DASHBOARD_POLL_FRESHNESS_MS, 120_000,
  "dashboard freshness must use the existing 120-second runtime observation boundary");

assert.deepEqual(
  getDashboardSessionRecovery(user),
  {
    title: 'SPX session หมดอายุ — เชื่อมต่อบัญชีผู้ให้บริการด้านล่าง',
    actionLabel: 'ไปยังบัญชีผู้ให้บริการ',
    href: '#provider-auth-panel',
  },
  'own-team session recovery must target the self-service provider account panel, not legacy Cookie settings',
);

assert.deepEqual(
  getDashboardSessionRecovery(admin),
  {
    title: 'SPX session หมดอายุ — เลือกทีมและจัดการบัญชีผู้ให้บริการในหน้า Teams',
    actionLabel: 'ไปที่หน้า Teams',
    href: '/teams',
  },
  'admin recovery must go to the Teams selection workflow because the own-team panel is absent',
);

assert.deepEqual(
  getDashboardSessionRecovery({ ...user, teamId: null }),
  {
    title: 'SPX session หมดอายุ — กรุณาติดต่อผู้ดูแลระบบเพื่อเชื่อมต่อบัญชีของทีม',
    actionLabel: null,
    href: null,
  },
  'an unassigned user must not receive a dead recovery action for an unavailable team panel',
);

const freshRunning = getDashboardTeamControlState({
  user,
  team,
  metrics: metrics(),
  nowMs,
  isMutating: false,
});
assert.deepEqual(
  freshRunning,
  {
    canToggle: true,
    command: "disable",
    disabled: false,
    primaryLabel: "Live",
    primaryTone: "live",
    title: "Worker ทำงานและมีผล poll ล่าสุด — กดเพื่อปิดระบบบิทของทีม PTWL",
    runtimeReason: "Worker ทำงานและมีผล poll ล่าสุด",
    healthLabel: "บัญชีผู้ให้บริการ: ปกติ",
    healthTone: "healthy",
  },
  "only a running worker with a fresh same-team poll may claim Live",
);

const enabledStopped = getDashboardTeamControlState({
  user,
  team: { ...team, runtimeStatus: "stopped" },
  metrics: metrics(),
  nowMs,
  isMutating: false,
});
assert.equal(enabledStopped.primaryLabel, "Stopped",
  "saved enabled intent must not make a stopped worker look Live");
assert.equal(enabledStopped.command, "disable",
  "inspecting an enabled stopped worker must still offer disable rather than accidentally start it");
assert.equal(enabledStopped.title, "ทีมเปิดใช้งานอยู่ แต่ Worker หยุดทำงาน — กดเพื่อปิดระบบบิทของทีม PTWL");
assert.equal(enabledStopped.healthLabel, "บัญชีผู้ให้บริการ: ปกติ",
  "provider account health remains explicit and separate from stopped worker runtime");

const stalePoll = getDashboardTeamControlState({
  user,
  team,
  metrics: metrics({ timestamp: new Date(nowMs - DASHBOARD_POLL_FRESHNESS_MS - 1).toISOString() }),
  nowMs,
  isMutating: false,
});
assert.equal(stalePoll.primaryLabel, "Stale");
assert.equal(stalePoll.runtimeReason, "ไม่พบผล poll ใหม่ภายใน 120 วินาที");
assert.equal(stalePoll.healthLabel, "บัญชีผู้ให้บริการ: ล่าสุดปกติ (ข้อมูลเก่า)",
  "an old poll can preserve last-known provider health without claiming it is current");
assert.equal(stalePoll.healthTone, "unknown");

for (const [name, snapshot] of [
  ["missing poll", metrics({ timestamp: null })],
  ["mismatched team", metrics({ teamId: 8 })],
  ["invalid timestamp", metrics({ timestamp: "not-a-date" })],
  ["future timestamp", metrics({ timestamp: new Date(nowMs + 1).toISOString() })],
] as const) {
  const state = getDashboardTeamControlState({ user, team, metrics: snapshot, nowMs, isMutating: false });
  assert.equal(state.primaryLabel, "Unknown", `${name} must not be treated as a fresh running worker`);
  assert.equal(state.healthLabel, "บัญชีผู้ให้บริการ: ยังไม่ยืนยัน", `${name} must not default provider health to healthy`);
}

const paused = getDashboardTeamControlState({
  user,
  team: { ...team, runtimeStatus: "paused" },
  metrics: metrics({ isPaused: true }),
  nowMs,
  isMutating: false,
});
assert.equal(paused.primaryLabel, "Paused");
assert.equal(paused.runtimeReason, "Worker พักการ poll ชั่วคราว");

const expired = getDashboardTeamControlState({
  user,
  team: { ...team, runtimeStatus: "session_expired" },
  metrics: metrics({ status: "session_expired", isHealthy: false }),
  nowMs,
  isMutating: false,
});
assert.equal(expired.primaryLabel, "Session expired");
assert.equal(expired.healthLabel, "บัญชีผู้ให้บริการ: Session หมดอายุ");

const runtimeExpiredBeforeMetricsThreshold = getDashboardTeamControlState({
  user,
  team: { ...team, runtimeStatus: "session_expired" },
  metrics: metrics({ status: "same", isHealthy: true }),
  nowMs,
  isMutating: false,
});
assert.equal(runtimeExpiredBeforeMetricsThreshold.healthLabel, "บัญชีผู้ให้บริการ: Session หมดอายุ",
  "authoritative team runtime expiry must override a lagging healthy metrics snapshot");

const freshPollError = getDashboardTeamControlState({
  user,
  team,
  metrics: metrics({ status: "network", isHealthy: true }),
  nowMs,
  isMutating: false,
});
assert.equal(freshPollError.primaryLabel, "Error",
  "a fresh failed poll must block Live even before the consecutive-error session threshold flips");
assert.equal(freshPollError.runtimeReason, "ผล poll ล่าสุดล้มเหลว (network)");
assert.equal(freshPollError.healthLabel, "บัญชีผู้ให้บริการ: ปกติ",
  "a non-session poll failure remains separate from provider account health");

const disabledTeam = getDashboardTeamControlState({
  user,
  team: { ...team, enabled: false, runtimeStatus: "stopped" },
  metrics: metrics(),
  nowMs,
  isMutating: false,
});
assert.equal(disabledTeam.primaryLabel, "Off");
assert.equal(disabledTeam.command, "enable");
assert.equal(disabledTeam.title, "ทีมปิดใช้งานอยู่ — กดเพื่อเปิดระบบบิทของทีม PTWL");

const adminState = getDashboardTeamControlState({
  user: admin,
  team: null,
  metrics: metrics({ teamId: null }),
  nowMs,
  isMutating: false,
});
assert.equal(adminState.canToggle, false);
assert.equal(adminState.disabled, true);
assert.equal(adminState.primaryLabel, "Unknown");
assert.equal(adminState.healthLabel, "บัญชีผู้ให้บริการ: ยังไม่ยืนยัน");
assert.equal(adminState.title, "Admin ดูสถานะจาก Dashboard ได้เท่านั้น ใช้หน้า Teams เพื่อเลือกทีมและจัดการระบบบิท");

console.log("frontend-dashboard-team-control: truthful runtime, freshness, provider health and permissions passed");
