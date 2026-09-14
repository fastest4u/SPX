import {
  heartbeatRuntimeNode,
  upsertRuntimeNode,
  type RuntimeNodeHeartbeatInput,
  type UpsertRuntimeNodeInput,
} from "../repositories/runtime-repository.js";
import { logger } from "../utils/logger.js";
import {
  runtimeNodeRegistration,
  type RuntimeNodeReleaseRegistration,
  type RuntimeReleaseIdentity,
} from "./runtime-release-identity.js";

export const RUNTIME_NODE_LOOP_MODES = [
  "poller",
  "autoAcceptDryRun",
  "autoAcceptReal",
  "autoAcceptSettlement",
] as const;

export type RuntimeNodeLoopMode = (typeof RUNTIME_NODE_LOOP_MODES)[number];
export type DedicatedRuntimeNodeRole = "poller-service" | "auto-accept-service";
export type RuntimeNodeHeartbeatRole = DedicatedRuntimeNodeRole | "line-service";

export type RuntimeNodeHeartbeatMetadata = {
  assignedTeamIds: number[];
  enabledLoopModes: RuntimeNodeLoopMode[];
} & Partial<RuntimeNodeReleaseRegistration["metadata"]>;

export interface RuntimeNodeHeartbeatRegistration {
  nodeId: string;
  role: RuntimeNodeHeartbeatRole;
  version?: string;
  metadata: RuntimeNodeHeartbeatMetadata;
}

export interface StartRuntimeNodeHeartbeatOptions {
  nodeId: string;
  role: RuntimeNodeHeartbeatRole;
  assignedTeamIds: readonly number[];
  enabledLoopModes: readonly RuntimeNodeLoopMode[];
  intervalMs: number;
  releaseIdentity?: RuntimeReleaseIdentity;
  startedAt?: string;
  registerNode?: (input: UpsertRuntimeNodeInput) => Promise<void>;
  writeHeartbeat?: (input: RuntimeNodeHeartbeatInput) => Promise<boolean>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RuntimeNodeHeartbeatHandle {
  runOnce(): Promise<boolean | null>;
  stop(): void;
}

const runtimeNodeLoopModeSet = new Set<string>(RUNTIME_NODE_LOOP_MODES);

function normalizeNodeId(nodeId: string): string {
  const normalized = nodeId.trim();
  if (!normalized) throw new Error("nodeId is required");
  return normalized;
}

function normalizeAssignedTeamIds(
  teamIds: readonly number[],
  role: RuntimeNodeHeartbeatRole,
): number[] {
  if (role === "line-service") {
    if (teamIds.length !== 0) throw new Error("line-service cannot have assignedTeamIds");
    return [];
  }
  if (teamIds.length === 0) {
    throw new Error("assignedTeamIds must include at least one team id");
  }
  for (const teamId of teamIds) {
    if (!Number.isInteger(teamId) || teamId <= 0) {
      throw new Error("assignedTeamIds must contain positive integers");
    }
  }
  return [...new Set(teamIds)].sort((left, right) => left - right);
}

function normalizeLoopModes(
  modes: readonly RuntimeNodeLoopMode[],
  role: RuntimeNodeHeartbeatRole,
): RuntimeNodeLoopMode[] {
  if (role === "line-service") {
    if (modes.length !== 0) throw new Error("line-service cannot enable runtime loop modes");
    return [];
  }
  if (modes.length === 0) {
    throw new Error("enabledLoopModes must include at least one mode");
  }
  for (const mode of modes) {
    if (!runtimeNodeLoopModeSet.has(mode)) {
      throw new Error("enabledLoopModes contains an unsupported mode");
    }
  }
  if (role === "poller-service" && modes.some((mode) => mode !== "poller")) {
    throw new Error("poller-service may enable only poller mode");
  }
  if (role === "auto-accept-service" && modes.includes("poller")) {
    throw new Error("auto-accept-service cannot enable poller mode");
  }
  const selected = new Set<RuntimeNodeLoopMode>(modes);
  return RUNTIME_NODE_LOOP_MODES.filter((mode) => selected.has(mode));
}

function buildRegistration(options: StartRuntimeNodeHeartbeatOptions): RuntimeNodeHeartbeatRegistration {
  if (
    options.role !== "poller-service" &&
    options.role !== "auto-accept-service" &&
    options.role !== "line-service"
  ) {
    throw new Error("role must support runtime-node heartbeat");
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("intervalMs must be a positive integer");
  }
  const registration: RuntimeNodeHeartbeatRegistration = {
    nodeId: normalizeNodeId(options.nodeId),
    role: options.role,
    metadata: {
      assignedTeamIds: normalizeAssignedTeamIds(options.assignedTeamIds, options.role),
      enabledLoopModes: normalizeLoopModes(options.enabledLoopModes, options.role),
    },
  };
  if (options.releaseIdentity) {
    const release = runtimeNodeRegistration(options.releaseIdentity, options.startedAt);
    registration.version = release.version;
    registration.metadata = { ...registration.metadata, ...release.metadata };
  }
  return registration;
}

export async function startRuntimeNodeHeartbeat(
  options: StartRuntimeNodeHeartbeatOptions,
): Promise<RuntimeNodeHeartbeatHandle> {
  const registration = buildRegistration(options);
  const registerNode = options.registerNode ?? upsertRuntimeNode;
  const writeHeartbeat = options.writeHeartbeat ?? heartbeatRuntimeNode;
  const scheduleInterval = options.setIntervalFn ?? setInterval;
  const cancelInterval = options.clearIntervalFn ?? clearInterval;
  const warn = options.warn ?? logger.warn;

  try {
    await registerNode(registration);
  } catch {
    throw new Error("Runtime node heartbeat initial registration failed");
  }

  let stopped = false;
  let activeWrite: Promise<boolean> | null = null;

  const runOnce = (): Promise<boolean | null> => {
    if (stopped) return Promise.resolve(null);
    if (activeWrite) return activeWrite;

    const write = (async (): Promise<boolean> => {
      try {
        const updated = await writeHeartbeat({ nodeId: registration.nodeId });
        if (!updated) {
          if (stopped) return false;
          await registerNode(registration);
        }
        return true;
      } catch {
        warn("runtime-node-heartbeat-write-failed", {
          nodeId: registration.nodeId,
          role: registration.role,
        });
        return false;
      }
    })();
    const tracked = write.finally(() => {
      if (activeWrite === tracked) activeWrite = null;
    });
    activeWrite = tracked;
    return tracked;
  };

  const timer = scheduleInterval(() => {
    void runOnce();
  }, options.intervalMs);

  return {
    runOnce,
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelInterval(timer);
    },
  };
}
