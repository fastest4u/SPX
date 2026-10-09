import assert from "node:assert/strict";
import {
  isLineStatusCommand,
  formatTeamStatusReport,
  handleLineStatusCommand,
  formatThaiDateTime,
  type TeamStatusContext,
} from "../src/services/line-status-command.js";
import type { NotifyRule } from "../src/services/notify-rules.js";

async function main(): Promise<void> {
  // ── 1. Command detection ───────────────────────────────────────────
  assert.equal(isLineStatusCommand("!Status"), true);
  assert.equal(isLineStatusCommand("!status"), true);
  assert.equal(isLineStatusCommand("!STATUS"), true);
  assert.equal(isLineStatusCommand("!สถานะ"), true);
  assert.equal(isLineStatusCommand("  !status  "), true);
  assert.equal(isLineStatusCommand("!status all"), true);
  assert.equal(isLineStatusCommand("status"), false);
  assert.equal(isLineStatusCommand("!other"), false);
  assert.equal(isLineStatusCommand(""), false);
  assert.equal(isLineStatusCommand(undefined), false);

  // ── 2. Timezone verification (Asia/Bangkok) ────────────────────────
  // UTC 07:45 corresponds to 14:45 Bangkok time
  const utcDate = new Date("2026-10-09T07:45:00.000Z");
  const formattedTime = formatThaiDateTime(utcDate);
  assert.match(formattedTime, /14:45/);

  // ── 3. Report formatting ───────────────────────────────────────────
  const mockRules: NotifyRule[] = [
    {
      id: "rule-1",
      teamId: 1,
      name: "บางนา -> โซนในเมือง",
      origins: ["HUB บางนา", "HUB สำโรง"],
      destinations: ["โซนในเมือง", "ยานนาวา"],
      vehicle_types: ["4W", "4W-JUMBO"],
      need: 5,
      enabled: true,
      fulfilled: false,
      auto_accept: true,
      accept_all: false,
      auto_accepted: false,
    },
    {
      id: "rule-2",
      teamId: 1,
      name: "วังน้อย -> อยุธยา",
      origins: ["HUB วังน้อย"],
      destinations: ["อยุธยา"],
      vehicle_types: ["6W"],
      need: 3,
      enabled: true,
      fulfilled: true,
      auto_accept: true,
      accept_all: true,
      auto_accepted: true,
    },
    {
      id: "rule-3",
      teamId: 1,
      name: "กฎที่ปิดพักไว้",
      origins: [],
      destinations: [],
      vehicle_types: [],
      need: 1,
      enabled: false,
      fulfilled: false,
      auto_accept: true,
      accept_all: false,
      auto_accepted: false,
    },
  ];

  const report = formatTeamStatusReport({
    team: {
      id: 1,
      name: "Team 1 (PTWL)",
      enabled: true,
      biddingVehicleType: 2,
    },
    rules: mockRules,
    now: new Date("2026-10-09T07:45:00.000Z"),
  });

  assert.match(report, /Team 1 \(PTWL\)/);
  assert.match(report, /เปิดใช้งาน/);
  assert.match(report, /4WH-4ล้อ/); // vehicle type 2
  assert.match(report, /บางนา -> โซนในเมือง/);
  assert.match(report, /HUB บางนา, HUB สำโรง/);
  assert.match(report, /โซนในเมือง, ยานนาวา/);
  assert.match(report, /4W, 4W-JUMBO/);
  assert.match(report, /โควต้า: 5 คัน/);
  assert.match(report, /กำลังหา/);
  assert.match(report, /วังน้อย -> อยุธยา/);
  assert.match(report, /ครบแล้ว/);
  assert.doesNotMatch(report, /กฎที่ปิดพักไว้/);
  assert.match(report, /2 รายการ/); // Only 2 active rules

  // ── 4. Rule capping (> 15 rules) ──────────────────────────────────
  const manyRules: NotifyRule[] = Array.from({ length: 20 }, (_, i) => ({
    id: `rule-many-${i}`,
    teamId: 1,
    name: `กฎทดสอบที่ ${i + 1}`,
    origins: [`HUB ${i + 1}`],
    destinations: ["กทม."],
    vehicle_types: ["4W"],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  }));

  const cappedReport = formatTeamStatusReport({
    team: { id: 1, name: "Team 1", enabled: true, biddingVehicleType: null },
    rules: manyRules,
    now: utcDate,
  });
  assert.match(cappedReport, /และอีก 5 กฎ \(ดูรายละเอียดเต็มบน Dashboard\)/);

  // ── 5. Command handler matching team ───────────────────────────────
  const mockTeams: TeamStatusContext[] = [
    {
      id: 1,
      name: "Team 1 (PTWL)",
      enabled: true,
      biddingVehicleType: 2,
      lineGroupId: "c-team-1-group",
      autoAcceptSuccessLineGroupId: "c-team-1-success",
      autoAcceptFailureLineGroupId: "c-team-1-fail",
    },
    {
      id: 2,
      name: "Team 2 (IFN)",
      enabled: false,
      biddingVehicleType: null,
      lineGroupId: "c-team-2-group",
      autoAcceptSuccessLineGroupId: "c-team-2-success",
      autoAcceptFailureLineGroupId: "c-team-2-fail",
    },
    {
      id: 3,
      name: "Team 3 (Unlinked)",
      enabled: true,
      biddingVehicleType: null,
      lineGroupId: "",
      autoAcceptSuccessLineGroupId: "",
      autoAcceptFailureLineGroupId: "",
    },
  ];

  // Match via lineGroupId
  const reply1 = await handleLineStatusCommand({
    chatId: "c-team-1-group",
    teams: mockTeams,
    rules: mockRules,
    now: utcDate,
  });
  assert.match(reply1, /Team 1 \(PTWL\)/);
  assert.match(reply1, /บางนา -> โซนในเมือง/);

  // Match via autoAcceptSuccessLineGroupId
  const replySuccessGroup = await handleLineStatusCommand({
    chatId: "c-team-1-success",
    teams: mockTeams,
    rules: mockRules,
    now: utcDate,
  });
  assert.match(replySuccessGroup, /Team 1 \(PTWL\)/);

  // Match via autoAcceptFailureLineGroupId
  const replyFailureGroup = await handleLineStatusCommand({
    chatId: "c-team-1-fail",
    teams: mockTeams,
    rules: mockRules,
    now: utcDate,
  });
  assert.match(replyFailureGroup, /Team 1 \(PTWL\)/);

  // Unmatched chat
  const replyUnmatched = await handleLineStatusCommand({
    chatId: "c-unknown-chat",
    teams: mockTeams,
    rules: mockRules,
    now: utcDate,
  });
  assert.match(replyUnmatched, /ไม่พบข้อมูลทีมที่ผูกกับกลุ่มนี้/);

  // Empty or whitespace chatId does NOT match unlinked team (Team 3)
  const replyEmpty = await handleLineStatusCommand({
    chatId: "   ",
    teams: mockTeams,
    rules: mockRules,
    now: utcDate,
  });
  assert.match(replyEmpty, /ไม่พบข้อมูล Chat ID/);

  // Team with no active rules
  const replyTeam2 = await handleLineStatusCommand({
    chatId: "c-team-2-group",
    teams: mockTeams,
    rules: mockRules, // team 2 has 0 rules in mockRules
    now: utcDate,
  });
  assert.match(replyTeam2, /Team 2 \(IFN\)/);
  assert.match(replyTeam2, /ปิดใช้งาน/);
  assert.match(replyTeam2, /ไม่มีกฎที่เปิดใช้งาน/);

  console.log("All line-status-command tests passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
