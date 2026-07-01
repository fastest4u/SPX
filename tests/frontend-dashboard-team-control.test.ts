import assert from "node:assert/strict";

import { getDashboardTeamControlState } from "../src/frontend/routes/index.tsx";
import type { AuthUser, Team } from "../src/frontend/types/index.ts";

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

assert.deepEqual(
  getDashboardTeamControlState({
    user,
    team,
    isSystemPaused: false,
    isSessionHealthy: true,
    isMutating: false,
  }),
  {
    canToggle: true,
    command: "disable",
    disabled: false,
    primaryLabel: "Live",
    primaryTone: "live",
    title: "กดเพื่อปิดระบบบิทของทีม PTWL",
    healthLabel: "Healthy",
    healthTone: "healthy",
  },
  "team users should be able to turn off their own enabled team from the dashboard status pill",
);

assert.deepEqual(
  getDashboardTeamControlState({
    user,
    team: { ...team, enabled: false, runtimeStatus: "stopped" },
    isSystemPaused: false,
    isSessionHealthy: true,
    isMutating: false,
  }),
  {
    canToggle: true,
    command: "enable",
    disabled: false,
    primaryLabel: "Off",
    primaryTone: "off",
    title: "กดเพื่อเปิดระบบบิทของทีม PTWL",
    healthLabel: "Healthy",
    healthTone: "healthy",
  },
  "team users should be able to turn on their own disabled team from the dashboard status pill",
);

assert.deepEqual(
  getDashboardTeamControlState({
    user: admin,
    team,
    isSystemPaused: false,
    isSessionHealthy: true,
    isMutating: false,
  }),
  {
    canToggle: false,
    command: null,
    disabled: true,
    primaryLabel: "Live",
    primaryTone: "live",
    title: "Admin ดูสถานะจาก Dashboard ได้เท่านั้น ใช้หน้า Teams เพื่อเปิดหรือปิดทีม",
    healthLabel: "Healthy",
    healthTone: "healthy",
  },
  "admins should see dashboard status as read-only because team controls live on the Teams page",
);

console.log("frontend-dashboard-team-control: all assertions passed");
