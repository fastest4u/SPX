import type { RuntimeRole } from "./runtime-role.js";
import { roleRunsLineService } from "./runtime-role.js";
import { logger as defaultLogger } from "../utils/logger.js";

export interface LineImageListenerRuntimeLogger {
  info(event: string, meta: Record<string, unknown>): void;
  error(event: string, meta: Record<string, unknown>): void;
}

export interface StartLineImageListenerForRoleOptions {
  role: RuntimeRole;
  nodeId: string;
  chatId: string;
  startImageListener?: (chatId: string) => Promise<void>;
  initializeLineClient?: () => Promise<void>;
  logger?: LineImageListenerRuntimeLogger;
}

function maskTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= 4 ? "****" : `****${trimmed.slice(-4)}`;
}

function roleOwnsLineClient(role: RuntimeRole): boolean {
  return role === "notifier" || roleRunsLineService(role);
}

export function shouldStartLineImageListener(
  role: RuntimeRole,
  chatId: string | undefined,
): boolean {
  return roleOwnsLineClient(role) && Boolean(chatId?.trim());
}

async function resolveStartImageListener(
  startImageListener: ((chatId: string) => Promise<void>) | undefined,
): Promise<(chatId: string) => Promise<void>> {
  if (startImageListener) return startImageListener;
  const lineBot = await import("./line-bot.js");
  return lineBot.startImageListener;
}

async function resolveInitializeLineClient(
  initializeLineClient: (() => Promise<void>) | undefined,
): Promise<() => Promise<void>> {
  if (initializeLineClient) return initializeLineClient;
  const lineBot = await import("./line-bot.js");
  return async () => {
    await lineBot.getClient();
  };
}

export async function startLineImageListenerForRole(
  options: StartLineImageListenerForRoleOptions,
): Promise<boolean> {
  if (!roleOwnsLineClient(options.role)) return false;

  const log = options.logger ?? defaultLogger;
  const chatId = options.chatId.trim();
  if (!chatId) {
    const initializeLineClient = await resolveInitializeLineClient(options.initializeLineClient);
    log.info("line-service-client-initialization-started", {
      role: options.role,
      nodeId: options.nodeId,
    });
    void Promise.resolve()
      .then(() => initializeLineClient())
      .catch((error) => {
        log.error("line-service-client-initialization-failed", {
          role: options.role,
          nodeId: options.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  const startImageListener = await resolveStartImageListener(options.startImageListener);

  log.info("line-image-listener-started", {
    role: options.role,
    nodeId: options.nodeId,
    chatId: maskTarget(chatId),
  });
  void Promise.resolve()
    .then(() => startImageListener(chatId))
    .catch((error) => {
      log.error("line-image-listener-start-failed", {
        role: options.role,
        nodeId: options.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
}
