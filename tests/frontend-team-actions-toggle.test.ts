import assert from "node:assert/strict";

import { getTeamEnableToggleAction } from "../src/frontend/routes/teams.tsx";

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

console.log("frontend-team-actions-toggle: all assertions passed");
