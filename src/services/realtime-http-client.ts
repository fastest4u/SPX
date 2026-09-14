import { randomUUID } from "node:crypto";
import { signedJsonPost } from "./internal-service-client.js";
import {
  createRealtimeEnvelope,
  type RealtimePublishInput,
  type RealtimePublishResult,
  type RealtimePublisher,
} from "./realtime-contract.js";

const REALTIME_EVENTS_PATH = "/internal/realtime/events";

export interface SignedHttpRealtimePublisherOptions {
  url: string;
  sharedSecret: string;
  nodeId: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}

export class RealtimePublishHttpError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "RealtimePublishHttpError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export class SignedHttpRealtimePublisher implements RealtimePublisher {
  constructor(private readonly options: SignedHttpRealtimePublisherOptions) {}

  async publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    createRealtimeEnvelope(input);
    if (input.source.nodeId.trim() !== this.options.nodeId.trim()) {
      throw new RealtimePublishHttpError("Realtime source node must match the signing node", {
        retryable: false,
      });
    }

    const result = await signedJsonPost<RealtimePublishInput<TPayload>, RealtimePublishResult>({
      url: this.options.url,
      sharedSecret: this.options.sharedSecret,
      nodeId: this.options.nodeId,
      body: input,
      eventKey: input.idempotencyKey,
      // Every realtime publish opts into the replay-protected request-id
      // binding; the endpoint rejects duplicated request ids.
      requestId: randomUUID(),
      fetchImpl: this.options.fetchImpl,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });

    if (!result.ok) {
      // Surface a stable status-bound code instead of echoing the remote
      // body, which may contain internal details that must not leak.
      throw new RealtimePublishHttpError(
        result.status === undefined ? "INTERNAL_NETWORK_ERROR" : `INTERNAL_HTTP_${result.status}`,
        {
          retryable: result.retryable,
          status: result.status,
        },
      );
    }

    return result.data;
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish({
      ...input,
      replayable: input.replayable ?? false,
    });
  }
}

export function createSignedHttpRealtimePublisher(
  options: SignedHttpRealtimePublisherOptions,
): SignedHttpRealtimePublisher {
  return new SignedHttpRealtimePublisher(options);
}

export { REALTIME_EVENTS_PATH };
