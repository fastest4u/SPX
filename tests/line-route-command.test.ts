import assert from "node:assert/strict";
import {
  isLineRouteCommand,
  parseRouteCommands,
  normalizeVehicleType,
  handleLineRouteCommand,
  type ParsedRouteCommand,
} from "../src/services/line-route-command.js";
import type { TeamStatusContext } from "../src/repositories/team-repository.js";
import type { NotifyRule, NotifyRuleInput, NotifyRulePatch } from "../src/services/notify-rules.js";

async function main(): Promise<void> {
  // ── 1. Command detection (isLineRouteCommand) ─────────────────────────
  assert.equal(isLineRouteCommand("+ SOCN-GBKK 6 4W"), true);
  assert.equal(isLineRouteCommand("+ SOCN-HUB 6คัน 4W"), true);
  assert.equal(isLineRouteCommand("+ SOCN - HUB 6 4W"), true);
  assert.equal(isLineRouteCommand("+ SOCN-HUB 6"), true);
  assert.equal(isLineRouteCommand("+ SOCN-HUB 6คัน"), true);
  assert.equal(isLineRouteCommand("- SOCN-GBKK"), true);
  assert.equal(isLineRouteCommand("- SOCN - HUB"), true);

  // Multi-line
  const multiLine = "+ SOCN-GBKK 6 4W\n+ SOCN-HUB 6 4W";
  assert.equal(isLineRouteCommand(multiLine), true);

  // Negative cases
  assert.equal(isLineRouteCommand("+1"), false);
  assert.equal(isLineRouteCommand("+ 1"), false);
  assert.equal(isLineRouteCommand("- สวัสดี"), false);
  assert.equal(isLineRouteCommand("- 123"), false);
  assert.equal(isLineRouteCommand("!status"), false);
  assert.equal(isLineRouteCommand("hello"), false);
  assert.equal(isLineRouteCommand(""), false);
  assert.equal(isLineRouteCommand(undefined), false);

  // ── 2. Vehicle type normalization ─────────────────────────────────────
  assert.deepEqual(normalizeVehicleType("4W"), ["4WH-4ล้อ"]);
  assert.deepEqual(normalizeVehicleType("4w"), ["4WH-4ล้อ"]);
  assert.deepEqual(normalizeVehicleType("4WH"), ["4WH-4ล้อ"]);
  assert.deepEqual(normalizeVehicleType("4ล้อ"), ["4WH-4ล้อ"]);
  assert.deepEqual(normalizeVehicleType("6W"), ["6WH-6ล้อ[7.2m]"]);
  assert.deepEqual(normalizeVehicleType("6w"), ["6WH-6ล้อ[7.2m]"]);
  assert.deepEqual(normalizeVehicleType("6WH"), ["6WH-6ล้อ[7.2m]"]);
  assert.deepEqual(normalizeVehicleType("6ล้อ"), ["6WH-6ล้อ[7.2m]"]);
  assert.deepEqual(normalizeVehicleType("พ่วง"), ["Semi trailer-รถพ่วงแม่ลูก"]);
  assert.deepEqual(normalizeVehicleType("all"), []);
  assert.deepEqual(normalizeVehicleType(undefined), ["4WH-4ล้อ"]);

  // ── 3. Parsing commands ───────────────────────────────────────────────
  const parsed1 = parseRouteCommands("+ SOCN-GBKK 6 4W");
  assert.equal(parsed1.length, 1);
  assert.equal(parsed1[0].action, "add_or_update");
  assert.equal(parsed1[0].origin, "SOCN");
  assert.equal(parsed1[0].destination, "GBKK");
  assert.equal(parsed1[0].need, 6);
  assert.deepEqual(parsed1[0].vehicleTypes, ["4WH-4ล้อ"]);

  const parsedMulti = parseRouteCommands("+ SOCN-GBKK 6 4W\n+ SOCN-HUB 6คัน 4W\n- BKK-CNX");
  assert.equal(parsedMulti.length, 3);
  assert.equal(parsedMulti[0].origin, "SOCN");
  assert.equal(parsedMulti[0].destination, "GBKK");
  assert.equal(parsedMulti[0].need, 6);

  assert.equal(parsedMulti[1].origin, "SOCN");
  assert.equal(parsedMulti[1].destination, "HUB");
  assert.equal(parsedMulti[1].need, 6);

  assert.equal(parsedMulti[2].action, "remove");
  assert.equal(parsedMulti[2].origin, "BKK");
  assert.equal(parsedMulti[2].destination, "CNX");

  // ── 4. Execution & Handler integration ────────────────────────────────
  const mockTeams: TeamStatusContext[] = [
    {
      id: 1,
      name: "PTWL",
      enabled: true,
      biddingVehicleType: 2,
      lineGroupId: "c-ptwl-group",
      autoAcceptSuccessLineGroupId: "c-ptwl-success",
      autoAcceptFailureLineGroupId: "c-ptwl-failure",
    },
  ];

  const inMemoryRules: NotifyRule[] = [
    {
      id: "rule-existing-hub",
      teamId: 1,
      name: "SOCN-HUB",
      origins: ["SOCN"],
      destinations: ["HUB"],
      vehicle_types: ["4WH-4ล้อ"],
      need: 2,
      enabled: true,
      fulfilled: false,
      auto_accept: true,
      accept_all: false,
      auto_accepted: false,
    },
  ];

  const mockRuleOps = {
    async readRules(teamId: number): Promise<NotifyRule[]> {
      return inMemoryRules.filter((r) => r.teamId === teamId);
    },
    async createRule(teamId: number, input: NotifyRuleInput): Promise<NotifyRule> {
      const created: NotifyRule = {
        id: `rule-${Date.now()}-${Math.random()}`,
        teamId,
        name: input.name,
        origins: input.origins ?? [],
        destinations: input.destinations ?? [],
        vehicle_types: input.vehicle_types ?? [],
        need: input.need ?? 1,
        enabled: input.enabled ?? true,
        fulfilled: false,
        auto_accept: true,
        accept_all: input.accept_all ?? false,
        auto_accepted: false,
      };
      inMemoryRules.push(created);
      return created;
    },
    async updateRule(teamId: number, id: string, patch: NotifyRulePatch): Promise<NotifyRule | null> {
      const target = inMemoryRules.find((r) => r.id === id && r.teamId === teamId);
      if (!target) return null;
      if (patch.need !== undefined) target.need = patch.need;
      if (patch.enabled !== undefined) target.enabled = patch.enabled;
      if (patch.fulfilled !== undefined) target.fulfilled = patch.fulfilled;
      if (patch.vehicle_types !== undefined) target.vehicle_types = patch.vehicle_types;
      return target;
    },
  };

  // Case A: "+ SOCN-GBKK 6 4W" -> Brand new rule added, existing SOCN-HUB untouched
  const replyA = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "+ SOCN-GBKK 6 4W",
    teams: mockTeams,
    ruleOps: mockRuleOps,
  });

  assert.match(replyA, /บันทึกเส้นทางเรียบร้อย/);
  assert.match(replyA, /PTWL/);
  assert.match(replyA, /SOCN ➔ GBKK/);
  assert.match(replyA, /6 คัน/);
  assert.match(replyA, /4WH-4ล้อ/);

  // Verify SOCN-HUB is STILL 2 and enabled
  const hubRule = inMemoryRules.find((r) => r.id === "rule-existing-hub");
  assert.ok(hubRule);
  assert.equal(hubRule.need, 2);
  assert.equal(hubRule.enabled, true);

  // Verify SOCN-GBKK was created
  const gbkkRule = inMemoryRules.find((r) => r.name === "SOCN-GBKK");
  assert.ok(gbkkRule);
  assert.equal(gbkkRule.need, 6);
  assert.equal(gbkkRule.enabled, true);

  // Case B: "+ SOCN-HUB 6 4W" -> Updates existing SOCN-HUB need from 2 to 6 (Option 1)
  const replyB = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "+ SOCN-HUB 6 4W",
    teams: mockTeams,
    ruleOps: mockRuleOps,
  });

  assert.match(replyB, /อัปเดต/);
  assert.match(replyB, /SOCN ➔ HUB/);
  assert.match(replyB, /6 คัน/);
  assert.equal(hubRule.need, 6);
  assert.equal(hubRule.fulfilled, false);

  // Case C: "- SOCN-HUB" -> Disables SOCN-HUB
  const replyC = await handleLineRouteCommand({
    chatId: "c-ptwl-group",
    text: "- SOCN-HUB",
    teams: mockTeams,
    ruleOps: mockRuleOps,
  });

  assert.match(replyC, /ปิดการรับงาน/);
  assert.match(replyC, /SOCN ➔ HUB/);
  assert.equal(hubRule.enabled, false);

  // Case D: Unknown group
  const replyD = await handleLineRouteCommand({
    chatId: "c-unknown-group",
    text: "+ SOCN-GBKK 6 4W",
    teams: mockTeams,
    ruleOps: mockRuleOps,
  });
  assert.match(replyD, /ไม่พบข้อมูลทีมที่ผูกกับกลุ่มนี้/);

  console.log("All line-route-command tests passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
