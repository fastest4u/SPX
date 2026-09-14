import type { RealtimePublisher } from "./realtime-contract.js";
import {
  createSignedHttpRealtimePublisher,
  type SignedHttpRealtimePublisherOptions,
} from "./realtime-http-client.js";
import {
  createPersistentInProcessRealtimePublisher,
  type PersistentRealtimePublisherOptions,
  type RealtimeTransport,
} from "./realtime-publisher.js";

export interface RuntimeRealtimeRemoteConfig {
  url?: string;
  sharedSecret?: string;
  nodeId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: SignedHttpRealtimePublisherOptions["fetchImpl"];
}

export interface RuntimeRealtimePublisherOptions {
  remote?: RuntimeRealtimeRemoteConfig;
  localTransport?: RealtimeTransport;
  localPublisherOptions?: PersistentRealtimePublisherOptions;
}

function normalizedRemoteConfig(remote: RuntimeRealtimeRemoteConfig): SignedHttpRealtimePublisherOptions {
  const url = typeof remote.url === "string" ? remote.url.trim() : "";
  const sharedSecret = typeof remote.sharedSecret === "string" ? remote.sharedSecret : "";
  const nodeId = typeof remote.nodeId === "string" ? remote.nodeId.trim() : "";
  const requestTimeoutMs = remote.requestTimeoutMs;
  if (
    !url
    || !sharedSecret.trim()
    || !nodeId
    || typeof requestTimeoutMs !== "number"
    || !Number.isInteger(requestTimeoutMs)
    || requestTimeoutMs <= 0
  ) {
    throw new Error("Remote realtime configuration is incomplete");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Remote realtime URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote realtime URL is invalid");
  }

  return {
    url,
    sharedSecret,
    nodeId,
    requestTimeoutMs,
    fetchImpl: remote.fetchImpl,
  };
}

export function createRuntimeRealtimePublisher(
  options: RuntimeRealtimePublisherOptions = {},
): RealtimePublisher {
  if (options.remote === undefined) {
    return createPersistentInProcessRealtimePublisher(
      options.localTransport,
      options.localPublisherOptions,
    );
  }

  return createSignedHttpRealtimePublisher(normalizedRemoteConfig(options.remote));
}
