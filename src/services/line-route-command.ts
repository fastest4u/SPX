import {
  readRules,
  createRule,
  updateRule,
  type NotifyRule,
  type NotifyRuleInput,
  type NotifyRulePatch,
} from "./notify-rules.js";
import {
  listAllTeamStatusContexts,
  type TeamStatusContext,
} from "../repositories/team-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { env } from "../config/env.js";

export const MAX_LINE_ROUTE_NEED = 1000;

export interface ParsedRouteCommand {
  action: "add_or_update" | "remove";
  origin: string;
  destination: string;
  need?: number;
  vehicleTypes?: string[];
  rawVehicleInput?: string;
}

const POSITIVE_ROUTE_REGEX =
  /^\s*\+\s*([A-Za-z0-9_-]+)\s*-\s*([A-Za-z0-9_-]+)\s+(\d+)(?:คัน)?(?:\s+(.+))?$/i;

const NEGATIVE_ROUTE_REGEX =
  /^\s*-\s*([A-Za-z0-9_-]+)\s*-\s*([A-Za-z0-9_-]+)(?:\s+(.+))?$/i;

export function isLineRouteCommand(text: string | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/);
  return lines.some((line) => {
    const trimmed = line.trim();
    return POSITIVE_ROUTE_REGEX.test(trimmed) || NEGATIVE_ROUTE_REGEX.test(trimmed);
  });
}

export function normalizeVehicleType(vehicleInput?: string): string[] {
  if (!vehicleInput || !vehicleInput.trim()) {
    return ["4WH-4ล้อ"];
  }

  const normalized = vehicleInput.trim().toLowerCase();

  if (/^(?:all|ทุกประเภท|ทุกคัน|\*)$/.test(normalized)) {
    return [];
  }

  if (/^(?:4w|4wh|4ล้อ|4\s*ล้อ)$/.test(normalized)) {
    return ["4WH-4ล้อ"];
  }

  if (/^(?:6w|6wh|6ล้อ|6\s*ล้อ)$/.test(normalized)) {
    return ["6WH-6ล้อ[7.2m]"];
  }

  if (/^(?:พ่วง|รถพ่วง|semi|trailer)$/.test(normalized)) {
    return ["Semi trailer-รถพ่วงแม่ลูก"];
  }

  return [vehicleInput.trim()];
}

export function parseRouteCommands(text: string): ParsedRouteCommand[] {
  const lines = text.split(/\r?\n/);
  const commands: ParsedRouteCommand[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const posMatch = POSITIVE_ROUTE_REGEX.exec(trimmed);
    if (posMatch) {
      const origin = posMatch[1].trim().toUpperCase();
      const destination = posMatch[2].trim().toUpperCase();
      const need = parseInt(posMatch[3], 10);
      const rawVehicleInput = posMatch[4]?.trim();
      const vehicleTypes = normalizeVehicleType(rawVehicleInput);

      if (Number.isInteger(need) && need > 0) {
        commands.push({
          action: "add_or_update",
          origin,
          destination,
          need,
          vehicleTypes,
          rawVehicleInput,
        });
      }
      continue;
    }

    const negMatch = NEGATIVE_ROUTE_REGEX.exec(trimmed);
    if (negMatch) {
      const origin = negMatch[1].trim().toUpperCase();
      const destination = negMatch[2].trim().toUpperCase();
      const rawVehicleInput = negMatch[3]?.trim();

      commands.push({
        action: "remove",
        origin,
        destination,
        rawVehicleInput,
      });
    }
  }

  return commands;
}

export interface RuleOperations {
  readRules(teamId: number): Promise<NotifyRule[]>;
  createRule(teamId: number, input: NotifyRuleInput): Promise<NotifyRule>;
  updateRule(teamId: number, id: string, patch: NotifyRulePatch): Promise<NotifyRule | null>;
}

const defaultRuleOperations: RuleOperations = {
  readRules,
  createRule,
  updateRule,
};

function formatVehicleLabel(vehicles?: string[]): string {
  if (!vehicles || vehicles.length === 0) return "ทุกประเภท";
  return vehicles.join(", ");
}

export type LineRouteAuditWriter = (
  username: string,
  action: string,
  details?: string,
  options?: { targetTeamId?: number | null },
) => Promise<void>;

export async function handleLineRouteCommand(options: {
  chatId: string;
  text: string;
  senderId?: string;
  allowedSenderIds?: ReadonlySet<string> | string[];
  teams?: TeamStatusContext[];
  ruleOps?: RuleOperations;
  auditWriter?: LineRouteAuditWriter;
}): Promise<string> {
  const { chatId, text } = options;
  const targetChatId = chatId?.trim();
  if (!targetChatId) {
    return "⚠️ ไม่พบข้อมูล Chat ID";
  }

  const configuredAllowlist =
    options.allowedSenderIds !== undefined
      ? new Set([...options.allowedSenderIds].map((id) => id.trim()).filter(Boolean))
      : env.LINE_COMMAND_ALLOWED_USER_IDS;

  if (configuredAllowlist.size > 0) {
    const normalizedSender = options.senderId?.trim() ?? "";
    if (!normalizedSender || !configuredAllowlist.has(normalizedSender)) {
      return "⚠️ คุณไม่มีสิทธิ์ใช้คำสั่งจัดการเส้นทางในกลุ่มนี้";
    }
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

  if (!matchedTeam) {
    return [
      "⚠️ ไม่พบข้อมูลทีมที่ผูกกับกลุ่มนี้",
      "💡 คำสั่ง + / - รองรับเฉพาะกลุ่ม LINE ที่ผูกกับทีมบอทเท่านั้น",
    ].join("\n");
  }

  const commands = parseRouteCommands(text);
  if (commands.length === 0) {
    return [
      "⚠️ รูปแบบคำสั่งไม่ถูกต้อง",
      "ตัวอย่างที่ถูกต้อง:",
      "  + SOCN-GBKK 6 4W",
      "  + SOCN-HUB 6คัน 4W",
      "  - SOCN-GBKK",
    ].join("\n");
  }

  const ruleOps = options.ruleOps ?? defaultRuleOperations;
  const existingRules = await ruleOps.readRules(matchedTeam.id);

  const results: string[] = [];
  let successCount = 0;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const originUpper = cmd.origin.toUpperCase();
    const destUpper = cmd.destination.toUpperCase();

    // Match rule by origin & destination or name
    const existing = existingRules.find((r) => {
      const originMatch = r.origins.some((o) => o.trim().toUpperCase() === originUpper);
      const destMatch = r.destinations.some((d) => d.trim().toUpperCase() === destUpper);
      if (originMatch && destMatch) return true;
      return r.name.trim().toUpperCase() === `${originUpper}-${destUpper}`;
    });

    if (cmd.action === "add_or_update") {
      const need = cmd.need ?? 1;
      const vehicleTypes = cmd.vehicleTypes ?? ["4WH-4ล้อ"];

      if (need > MAX_LINE_ROUTE_NEED) {
        results.push(
          `${i + 1}. ${cmd.origin} ➔ ${cmd.destination}\n` +
            `   • สถานะ: ⚠️ โควต้าเกินกำหนดสูงสุด (ไม่เกิน 1,000 คันต่อเส้นทาง)`,
        );
        continue;
      }

      if (existing) {
        // Option 1: Update target need, re-enable, and reset fulfilled
        await ruleOps.updateRule(matchedTeam.id, existing.id, {
          need,
          enabled: true,
          fulfilled: false,
          vehicle_types: vehicleTypes,
        });
        results.push(
          `${i + 1}. ${cmd.origin} ➔ ${cmd.destination}\n` +
            `   • โควต้าใหม่: ${need} คัน\n` +
            `   • ประเภทรถ: ${formatVehicleLabel(vehicleTypes)}\n` +
            `   • สถานะ: 🟢 อัปเดตโควต้าเรียบร้อย (Auto-accept)`,
        );
      } else {
        // Create new rule
        await ruleOps.createRule(matchedTeam.id, {
          name: `${cmd.origin}-${cmd.destination}`,
          origins: [cmd.origin],
          destinations: [cmd.destination],
          vehicle_types: vehicleTypes,
          need,
          enabled: true,
          fulfilled: false,
          accept_all: false,
        });
        results.push(
          `${i + 1}. ${cmd.origin} ➔ ${cmd.destination}\n` +
            `   • โควต้าใหม่: ${need} คัน\n` +
            `   • ประเภทรถ: ${formatVehicleLabel(vehicleTypes)}\n` +
            `   • สถานะ: 🟢 เปิดรับงานใหม่ (Auto-accept)`,
        );
      }
      successCount++;
    } else if (cmd.action === "remove") {
      if (existing) {
        await ruleOps.updateRule(matchedTeam.id, existing.id, {
          enabled: false,
        });
        results.push(
          `${i + 1}. ${cmd.origin} ➔ ${cmd.destination}\n` +
            `   • สถานะ: 🔴 ปิดการรับงานเรียบร้อย (Disabled)`,
        );
        successCount++;
      } else {
        results.push(
          `${i + 1}. ${cmd.origin} ➔ ${cmd.destination}\n` +
            `   • สถานะ: ⚠️ ไม่พบเส้นทางนี้ในระบบ`,
        );
      }
    }
  }

  if (successCount > 0) {
    const auditWriter = options.auditWriter ?? (options.ruleOps === undefined ? insertAuditLog : undefined);
    if (auditWriter) {
      const actor = options.senderId?.trim() ? `line:${options.senderId.trim()}` : "line-command";
      const summary = commands
        .map((c) => `${c.action === "remove" ? "-" : "+"}${c.origin}-${c.destination}${c.need ? `:${c.need}` : ""}`)
        .join(", ");
      await auditWriter(
        actor,
        "LINE Route Command",
        `Updated ${successCount} route rule(s) in chat ${targetChatId}: ${summary}`,
        { targetTeamId: matchedTeam.id },
      );
    }
  }

  const header =
    successCount > 0
      ? `✅ บันทึกเส้นทางเรียบร้อย (ทีม: ${matchedTeam.name})`
      : `⚠️ ทำรายการไม่สำเร็จ (ทีม: ${matchedTeam.name})`;

  return [
    header,
    "────────────────────",
    ...results,
    "────────────────────",
    "💡 พิมพ์ !Status เพื่อดูสถานะทั้งหมด",
  ].join("\n");
}
