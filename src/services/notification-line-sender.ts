import type { SendLineMessageResult } from "./notification-dispatcher.js";
import {
  sendLineServiceMessage,
  type LineServiceClientOptions,
  type LineServiceMessageResult,
} from "./line-service-client.js";
import type { LineServiceSendRequest } from "./line-service-contract.js";

export interface NotificationLineSenderOptions {
  lineServiceUrl: string;
  sharedSecret: string;
  nodeId: string;
  requestTimeoutMs: number;
  allowLocalFallback: boolean;
  sendRemoteLineMessage?: (
    options: LineServiceClientOptions,
    request: LineServiceSendRequest,
  ) => Promise<LineServiceMessageResult>;
  sendLocalLineMessage?: (targetId: string, text: string) => Promise<SendLineMessageResult>;
}

async function sendLocalLineMessage(
  targetId: string,
  text: string,
): Promise<SendLineMessageResult> {
  const notifier = await import("./notifier.js");
  return notifier.sendLineTargetMessage(targetId, text);
}

export function createNotificationLineSender(
  options: NotificationLineSenderOptions,
): (targetId: string, text: string) => Promise<SendLineMessageResult & { retryable?: boolean }> {
  return async (targetId: string, text: string) => {
    const lineServiceUrl = options.lineServiceUrl.trim();
    const remoteSender = options.sendRemoteLineMessage ?? sendLineServiceMessage;
    if (lineServiceUrl) {
      const result = await remoteSender(
        {
          baseUrl: lineServiceUrl,
          sharedSecret: options.sharedSecret,
          nodeId: options.nodeId,
          requestTimeoutMs: options.requestTimeoutMs,
        },
        { targetId, text },
      );
      if (result.ok || !options.allowLocalFallback) return result;
    }

    if (options.allowLocalFallback) {
      const localSender = options.sendLocalLineMessage ?? sendLocalLineMessage;
      return localSender(targetId, text);
    }

    return {
      ok: false,
      error: "LINE_SERVICE_URL is required",
      retryable: false,
    };
  };
}
