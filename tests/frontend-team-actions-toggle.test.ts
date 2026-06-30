import assert from "node:assert/strict";

import {
  getLineGroupSelectValue,
  getNextLinkedLineTarget,
  getTeamEnableToggleAction,
} from "../src/frontend/routes/teams.tsx";
import type { Team, TeamInput } from "../src/frontend/types/index.ts";

assert.deepEqual(
  getTeamEnableToggleAction({ name: "IFN", enabled: true }),
  {
    command: "disable",
    label: "Disable",
    title: "ปิดใช้งานทีม IFN",
    danger: true,
  },
  "enabled teams should expose a direct disable action",
);

assert.deepEqual(
  getTeamEnableToggleAction({ name: "PTWL", enabled: false }),
  {
    command: "enable",
    label: "Enable",
    title: "เปิดใช้งานทีม PTWL",
    danger: false,
  },
  "disabled teams should expose a direct enable action",
);

const teamWithNotificationTargets: Team = {
  id: 1,
  name: "IFN",
  enabled: true,
  hasSpxCookie: true,
  hasSpxDeviceId: true,
  hasLineGroupId: true,
  hasAutoAcceptSuccessLineGroupId: true,
  hasAutoAcceptFailureLineGroupId: true,
  spxCookiePreview: "********okie",
  spxDeviceIdPreview: "********vice",
  lineGroupIdPreview: "********base",
  autoAcceptSuccessLineGroupIdPreview: "********good",
  autoAcceptFailureLineGroupIdPreview: "********fail",
  runtimeStatus: "running",
  usersCount: 1,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

assert.equal(teamWithNotificationTargets.hasAutoAcceptSuccessLineGroupId, true);
assert.equal(teamWithNotificationTargets.autoAcceptFailureLineGroupIdPreview, "********fail");

const teamInputWithNotificationTargets: TeamInput = {
  name: "IFN",
  lineGroupId: "C-default-line-group",
  autoAcceptSuccessLineGroupId: "C-success-line-group",
  autoAcceptFailureLineGroupId: "C-failure-line-group",
};

assert.equal(teamInputWithNotificationTargets.autoAcceptSuccessLineGroupId, "C-success-line-group");
assert.equal(teamInputWithNotificationTargets.autoAcceptFailureLineGroupId, "C-failure-line-group");

assert.equal(
  getNextLinkedLineTarget({
    currentTarget: "",
    previousDefaultTarget: "",
    nextDefaultTarget: "C-default-a",
  }),
  "C-default-a",
  "blank linked targets should follow the selected default LINE target",
);

assert.equal(
  getNextLinkedLineTarget({
    currentTarget: "C-default-a",
    previousDefaultTarget: "C-default-a",
    nextDefaultTarget: "C-default-b",
  }),
  "C-default-b",
  "linked targets matching the previous default should follow a changed default LINE target",
);

assert.equal(
  getNextLinkedLineTarget({
    currentTarget: "C-manual-success",
    previousDefaultTarget: "C-default-a",
    nextDefaultTarget: "C-default-b",
  }),
  "C-manual-success",
  "manually different linked targets should not be overwritten by default LINE target changes",
);

const selectableLineGroups = [
  { chatMid: "C-default-a", chatName: "Default A" },
  { chatMid: "C-default-b", chatName: "Default B" },
];

assert.equal(
  getLineGroupSelectValue("********fail", selectableLineGroups),
  "********fail",
  "redacted saved LINE targets should render as the current select value",
);

assert.equal(
  getLineGroupSelectValue("C-default-b", selectableLineGroups),
  "C-default-b",
  "selectable LINE targets should render as their selected value",
);

assert.equal(
  getLineGroupSelectValue("U-not-a-group", selectableLineGroups),
  "",
  "non-selectable raw values should fall back to the placeholder",
);

console.log("frontend-team-actions-toggle: all assertions passed");
