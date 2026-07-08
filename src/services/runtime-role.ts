export type RuntimeRole =
  | "api"
  | "worker"
  | "notifier"
  | "combined"
  | "notification-service"
  | "line-service"
  | "ocr-service";

export type HttpSurface = "web-api" | "notification-service" | "line-service" | "ocr-service";

const RUNTIME_ROLE_VALUES: RuntimeRole[] = [
  "api",
  "worker",
  "notifier",
  "combined",
  "notification-service",
  "line-service",
  "ocr-service",
];

const DISTRIBUTED_RUNTIME_ROLES = new Set<RuntimeRole>([
  "worker",
  "notifier",
  "notification-service",
  "line-service",
  "ocr-service",
]);

const RUNTIME_ROLES = new Set<RuntimeRole>(RUNTIME_ROLE_VALUES);

export function parseRuntimeRole(value: string | undefined): RuntimeRole {
  const role = (value || "combined").trim().toLowerCase();
  if (RUNTIME_ROLES.has(role as RuntimeRole)) return role as RuntimeRole;
  throw new Error(`SPX_ROLE must be one of ${RUNTIME_ROLE_VALUES.join(", ")}`);
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

export function requireNodeIdForDistributedRole(
  role: RuntimeRole,
  nodeId: string | undefined,
): string | null {
  if (!DISTRIBUTED_RUNTIME_ROLES.has(role)) return null;
  const trimmed = (nodeId || "").trim();
  if (!trimmed) throw new Error("SPX_NODE_ID is required for distributed SPX_ROLE values");
  return trimmed;
}

export function httpSurfaceForRole(role: RuntimeRole): HttpSurface | null {
  if (role === "worker") return null;
  if (role === "notification-service") return "notification-service";
  if (role === "line-service") return "line-service";
  if (role === "ocr-service") return "ocr-service";
  return "web-api";
}

export function roleRunsHttp(role: RuntimeRole): boolean {
  return httpSurfaceForRole(role) !== null;
}

export function roleRunsWorkers(role: RuntimeRole): boolean {
  return role === "worker" || role === "combined";
}

export function roleRunsNotifier(role: RuntimeRole): boolean {
  return role === "notifier" || role === "notification-service" || role === "combined";
}

export function roleRunsLineService(role: RuntimeRole): boolean {
  return role === "line-service" || role === "combined";
}
