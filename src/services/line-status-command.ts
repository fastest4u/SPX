import { readRulesForScope, type NotifyRule } from "./notify-rules.js";
import {
  listAllTeamStatusContexts,
  type TeamStatusContext,
} from "../repositories/team-repository.js";

export type { TeamStatusContext };

export function isLineStatusCommand(text: string | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  return /^\s*!(?:status|สถานะ)(?:\s|$)/i.test(text);
}

export function formatVehicleTypeLabel(vehicleType?: number | null): string {
  switch (vehicleType) {
    case 13:
      return "6WH-6ล้อ [7.2m]";
    case 12:
      return "6WH-6ล้อ[5.5m]";
    case 8:
      return "Semi trailer-รถพ่วงแม่ลูก";
    case 2:
      return "4WH-4ล้อ";
    default:
      return typeof vehicleType === "number" ? `Type ${vehicleType}` : "ทั้งหมด (ไม่กรอง)";
  }
}

export function formatThaiDateTime(date: Date): string {
  return (
    new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date) + " น."
  );
}

function maskChatId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= 4 ? "****" : `****${trimmed.slice(-4)}`;
}

const MAX_RULES_DISPLAYED = 15;

export function formatTeamStatusReport(options: {
  team: {
    id: number;
    name: string;
    enabled: boolean;
    biddingVehicleType?: number | null;
  };
  rules: NotifyRule[];
  now?: Date;
}): string {
  const { team, rules, now = new Date() } = options;
  const activeRules = rules.filter((r) => r.teamId === team.id && r.enabled);

  const lines: string[] = [
    `📊 สถานะบอท SPX - ${team.name}`,
    "────────────────────",
    `🟢 สถานะทีม: ${team.enabled ? "เปิดใช้งาน (Active)" : "🔴 ปิดใช้งาน (Disabled)"}`,
    `⚡ รถที่ตั้งค่า: ${formatVehicleTypeLabel(team.biddingVehicleType)}`,
    "",
  ];

  if (activeRules.length === 0) {
    lines.push("📋 กฎที่เปิดใช้งาน: ไม่มีกฎที่เปิดใช้งาน (0 รายการ)");
  } else {
    lines.push(`📋 กฎที่เปิดใช้งาน (${activeRules.length} รายการ):`);
    const displayedRules = activeRules.slice(0, MAX_RULES_DISPLAYED);
    displayedRules.forEach((rule, idx) => {
      const origins = rule.origins.length > 0 ? rule.origins.join(", ") : "ทุกสาขา";
      const destinations = rule.destinations.length > 0 ? rule.destinations.join(", ") : "ทุกโซน";
      const vehicles = rule.vehicle_types.length > 0 ? rule.vehicle_types.join(", ") : "ทุกประเภท";
      const statusText = rule.fulfilled ? "ครบแล้ว (Fulfilled)" : "กำลังหา";

      lines.push(`${idx + 1}. [${rule.name}]`);
      lines.push(`   • ต้นทาง: ${origins}`);
      lines.push(`   • ปลายทาง: ${destinations}`);
      lines.push(`   • ประเภทรถ: ${vehicles}`);
      lines.push(`   • โควต้า: ${rule.need} คัน (${statusText})`);
    });

    if (activeRules.length > MAX_RULES_DISPLAYED) {
      const remaining = activeRules.length - MAX_RULES_DISPLAYED;
      lines.push(`...และอีก ${remaining} กฎ (ดูรายละเอียดเต็มบน Dashboard)`);
    }
  }

  lines.push("────────────────────");
  lines.push(`🕒 อัปเดตล่าสุด: ${formatThaiDateTime(now)}`);

  return lines.join("\n");
}

export async function handleLineStatusCommand(options: {
  chatId: string;
  teams?: TeamStatusContext[];
  rules?: NotifyRule[];
  now?: Date;
}): Promise<string> {
  const { chatId, now = new Date() } = options;
  const targetChatId = chatId?.trim();
  if (!targetChatId) {
    return "⚠️ ไม่พบข้อมูล Chat ID";
  }

  const teams = options.teams ?? (await listAllTeamStatusContexts());

  const matchedTeam = teams.find(
    (t) =>
      (Boolean(t.lineGroupId?.trim()) && t.lineGroupId.trim() === targetChatId) ||
      (Boolean(t.autoAcceptSuccessLineGroupId?.trim()) &&
        t.autoAcceptSuccessLineGroupId.trim() === targetChatId) ||
      (Boolean(t.autoAcceptFailureLineGroupId?.trim()) &&
        t.autoAcceptFailureLineGroupId.trim() === targetChatId),
  );

  if (matchedTeam) {
    const rules = options.rules ?? (await readRulesForScope(matchedTeam.id));
    return formatTeamStatusReport({ team: matchedTeam, rules, now });
  }

  return [
    "⚠️ ไม่พบข้อมูลทีมที่ผูกกับกลุ่มนี้",
    `Chat ID: ${maskChatId(targetChatId)}`,
    "",
    "💡 หากต้องการผูกกลุ่มนี้กับทีม กรุณาระบุ Line Group ID ในเมนูตั้งค่าทีมบน Dashboard",
  ].join("\n");
}
