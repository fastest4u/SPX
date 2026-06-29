export type RuntimeRole = "api" | "worker" | "notifier" | "combined";

const RUNTIME_ROLES = new Set<RuntimeRole>(["api", "worker", "notifier", "combined"]);

export function parseRuntimeRole(value: string | undefined): RuntimeRole {
  const role = (value || "combined").trim().toLowerCase();
  if (RUNTIME_ROLES.has(role as RuntimeRole)) return role as RuntimeRole;
  throw new Error("SPX_ROLE must be one of api, worker, notifier, combined");
}

export function parseRunTeamIds(value: string | undefined): number[] {
  if (!value || value.trim() === "") return [];
  const ids = value.split(",").map((part) => {
    const parsed = Number(part.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("RUN_TEAM_IDS must contain positive integer team ids");
    }
    return parsed;
  });
  return [...new Set(ids)];
}

export function requireNodeIdForDistributedRole(role: RuntimeRole, nodeId: string | undefined): string | null {
  if (role !== "worker" && role !== "notifier") return null;
  const trimmed = (nodeId || "").trim();
  if (!trimmed) throw new Error("SPX_NODE_ID is required when SPX_ROLE is worker or notifier");
  return trimmed;
}

export function roleRunsHttp(role: RuntimeRole): boolean {
  return role === "api" || role === "notifier" || role === "combined";
}

export function roleRunsWorkers(role: RuntimeRole): boolean {
  return role === "worker" || role === "combined";
}

export function roleRunsNotifier(role: RuntimeRole): boolean {
  return role === "notifier" || role === "combined";
}
