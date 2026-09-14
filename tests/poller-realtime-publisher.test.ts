import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { Poller } from "../src/controllers/poller.js";
import type { ApiClient } from "../src/services/api-client.js";
import type { PollingResult } from "../src/models/types.js";
import type {
  RealtimePublishInput,
  RealtimePublishResult,
  RealtimePublisher,
  RealtimeSource,
} from "../src/services/realtime-contract.js";
import type { LegacyRealtimeEvent } from "../src/services/realtime-publisher.js";

const mutableEnv = env as unknown as {
  AUTO_ACCEPT_ENABLED: boolean;
  FETCH_DETAILS: boolean;
  SAVE_TO_DB: boolean;
  SPX_NODE_ID?: string;
  SPX_NODE_NAME?: string;
  SPX_ROLE?: string;
  NOTIFIER_API_URL?: string;
  NOTIFIER_SHARED_SECRET?: string;
  NOTIFIER_REQUEST_TIMEOUT_MS?: number;
};

const originalEnv = {
  AUTO_ACCEPT_ENABLED: mutableEnv.AUTO_ACCEPT_ENABLED,
  FETCH_DETAILS: mutableEnv.FETCH_DETAILS,
  SAVE_TO_DB: mutableEnv.SAVE_TO_DB,
  SPX_NODE_ID: mutableEnv.SPX_NODE_ID,
  SPX_NODE_NAME: mutableEnv.SPX_NODE_NAME,
  SPX_ROLE: mutableEnv.SPX_ROLE,
  NOTIFIER_API_URL: mutableEnv.NOTIFIER_API_URL,
  NOTIFIER_SHARED_SECRET: mutableEnv.NOTIFIER_SHARED_SECRET,
  NOTIFIER_REQUEST_TIMEOUT_MS: mutableEnv.NOTIFIER_REQUEST_TIMEOUT_MS,
};
const originalFetch = globalThis.fetch;

class FakeRealtimePublisher implements RealtimePublisher {
  inputs: RealtimePublishInput[] = [];
  legacy: LegacyRealtimeEvent[] = [];

  async publish<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    this.inputs.push(input);
    return {
      accepted: true,
      duplicate: false,
      id: `event-${this.inputs.length}`,
      receivedAt: "2030-01-01T00:00:00.000Z",
      persisted: false,
    };
  }

  async publishSnapshot<TPayload>(input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    return this.publish(input);
  }

  async publishLegacy(event: LegacyRealtimeEvent): Promise<void> {
    this.legacy.push(event);
  }
}

class ThrowingRealtimePublisher extends FakeRealtimePublisher {
  override async publish<TPayload>(_input: RealtimePublishInput<TPayload>): Promise<RealtimePublishResult> {
    throw new Error("publisher unavailable");
  }
}

function successResult(requestNumber: number): PollingResult {
  return {
    success: true,
    latencyMs: 12,
    httpStatus: 200,
    timestamp: new Date("2030-01-01T00:00:00.000Z"),
    requestNumber,
    data: {
      retcode: 0,
      message: "",
      data: { list: [] },
    },
  };
}

function failedResult(requestNumber: number): PollingResult {
  return {
    success: false,
    latencyMs: 12,
    httpStatus: 503,
    error: "upstream unavailable",
    timestamp: new Date("2030-01-01T00:00:00.000Z"),
    requestNumber,
  };
}

function pollerFor(
  result: PollingResult,
  publisher: RealtimePublisher,
  source: RealtimeSource,
  sessionExpiryNotifier: (message: string) => Promise<{ sent: boolean; skipped?: boolean; results: [] }> = async () => ({ sent: false, skipped: true, results: [] }),
): Poller {
  const apiClient = {
    fetch: async (requestNumber: number) => ({ ...result, requestNumber }),
  } as unknown as ApiClient;

  return new Poller(undefined, {
    teamId: 7,
    teamName: "Realtime Team",
    lineGroupId: "",
    apiClient,
    realtimePublisher: publisher,
    realtimeSource: source,
    sessionExpiryNotifier,
  });
}

function defaultRealtimeSourceFor(): RealtimeSource {
  const poller = new Poller(undefined, {
    teamId: 7,
    teamName: "Realtime Team",
    lineGroupId: "",
    apiClient: { fetch: async (requestNumber: number) => successResult(requestNumber) } as unknown as ApiClient,
    realtimePublisher: new FakeRealtimePublisher(),
  });
  return (poller as unknown as { realtimeSource: RealtimeSource }).realtimeSource;
}

async function tick(poller: Poller): Promise<void> {
  await (poller as unknown as { tick: () => Promise<void> }).tick();
}

async function sendSessionExpiryAlert(poller: Poller, message: string): Promise<void> {
  await (poller as unknown as { sendSessionExpiryAlert: (errorMessage: string) => Promise<void> })
    .sendSessionExpiryAlert(message);
}

function assertMetricsPublication(publisher: FakeRealtimePublisher): void {
  assert.equal(publisher.inputs.length, 1);
  assert.equal(publisher.inputs[0]?.type, "metrics.snapshot");
  assert.equal(publisher.inputs[0]?.payloadVersion, 1);
  assert.deepEqual(publisher.inputs[0]?.scope, { kind: "team", teamId: 7 });
  assert.deepEqual(publisher.inputs[0]?.subject, { type: "team", id: "7", teamId: 7 });
  assert.equal(publisher.inputs[0]?.replayable, false);
  assert.deepEqual(publisher.legacy, [{
    event: "metrics",
    teamId: 7,
    data: publisher.inputs[0]?.payload,
  }]);
}

async function main(): Promise<void> {
  Object.assign(mutableEnv, {
    AUTO_ACCEPT_ENABLED: false,
    FETCH_DETAILS: false,
    SAVE_TO_DB: false,
  });

  const source: RealtimeSource = {
    service: "worker",
    nodeId: "poller-test-worker",
    role: "worker",
  };

  Object.assign(mutableEnv, {
    SPX_ROLE: "worker",
    SPX_NODE_ID: "worker-node-id",
    SPX_NODE_NAME: "worker-node-name",
  });
  assert.deepEqual(defaultRealtimeSourceFor(), {
    service: "worker",
    nodeId: "worker-node-id",
    role: "worker",
  });

  Object.assign(mutableEnv, {
    SPX_ROLE: "poller-service",
    SPX_NODE_ID: "poller-service-node",
    SPX_NODE_NAME: "",
  });
  assert.deepEqual(defaultRealtimeSourceFor(), {
    service: "poller-service",
    nodeId: "poller-service-node",
    role: "poller-service",
  });

  Object.assign(mutableEnv, {
    SPX_ROLE: "combined",
    SPX_NODE_ID: "combined-node-id",
    SPX_NODE_NAME: "",
  });
  assert.deepEqual(defaultRealtimeSourceFor(), {
    service: "worker",
    nodeId: "combined-node-id",
    role: "combined",
  });

  Object.assign(mutableEnv, {
    SPX_ROLE: "notifier",
    SPX_NODE_ID: "",
    SPX_NODE_NAME: "notifier-node-name",
  });
  assert.deepEqual(defaultRealtimeSourceFor(), {
    service: "web-api",
    nodeId: "notifier-node-name",
    role: "notifier",
  });

  Object.assign(mutableEnv, {
    SPX_ROLE: "",
    SPX_NODE_ID: "",
    SPX_NODE_NAME: "",
  });
  assert.deepEqual(defaultRealtimeSourceFor(), {
    service: "web-api",
    nodeId: "poller-team-7",
    role: "web-api",
  });

  const successfulPublisher = new FakeRealtimePublisher();
  await tick(pollerFor(successResult(1), successfulPublisher, source));
  assertMetricsPublication(successfulPublisher);
  assert.deepEqual(successfulPublisher.inputs[0]?.source, source);

  const failedPublisher = new FakeRealtimePublisher();
  await tick(pollerFor(failedResult(1), failedPublisher, source));
  assertMetricsPublication(failedPublisher);
  assert.deepEqual(failedPublisher.inputs[0]?.source, source);

  const throwingPublisher = new ThrowingRealtimePublisher();
  await assert.doesNotReject(tick(pollerFor(successResult(1), throwingPublisher, source)));
  await assert.doesNotReject(tick(pollerFor(failedResult(1), throwingPublisher, source)));
  assert.equal(throwingPublisher.legacy.length, 0);

  let sessionNotifications = 0;
  const sessionPublisher = new FakeRealtimePublisher();
  const sessionPoller = pollerFor(successResult(1), sessionPublisher, source, async () => {
    sessionNotifications += 1;
    return { sent: false, skipped: true, results: [] };
  });
  await sendSessionExpiryAlert(sessionPoller, "cookie expired");
  assert.equal(sessionNotifications, 1);
  assert.equal(sessionPublisher.inputs.length, 1);
  assert.equal(sessionPublisher.inputs[0]?.type, "session.expired");
  assert.equal(sessionPublisher.inputs[0]?.payloadVersion, 1);
  assert.deepEqual(sessionPublisher.inputs[0]?.scope, { kind: "team", teamId: 7 });
  assert.deepEqual(sessionPublisher.inputs[0]?.subject, { type: "team", id: "7", teamId: 7 });
  assert.deepEqual(sessionPublisher.inputs[0]?.source, source);
  assert.equal(sessionPublisher.legacy.length, 1);
  assert.equal(sessionPublisher.legacy[0]?.event, "session-expired");
  assert.equal(sessionPublisher.legacy[0]?.teamId, 7);

  let failOpenSessionNotifications = 0;
  const failOpenSessionPoller = pollerFor(successResult(1), new ThrowingRealtimePublisher(), source, async () => {
    failOpenSessionNotifications += 1;
    return { sent: false, skipped: true, results: [] };
  });
  await assert.doesNotReject(sendSessionExpiryAlert(failOpenSessionPoller, "cookie expired"));
  assert.equal(failOpenSessionNotifications, 1, "realtime failure must not skip the notification business path");

  const runtimeMetricsRequests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    runtimeMetricsRequests.push({ url: String(url), init: init ?? {} });
    return new Response("", { status: 202 });
  };
  Object.assign(mutableEnv, {
    SPX_ROLE: "poller-service",
    SPX_NODE_ID: "poller-runtime-node",
    NOTIFIER_API_URL: "http://notification-service.test/internal/notification-events",
    NOTIFIER_SHARED_SECRET: "test-shared-secret",
    NOTIFIER_REQUEST_TIMEOUT_MS: 1_000,
  });
  const runtimeMetricsPoller = pollerFor(successResult(1), new FakeRealtimePublisher(), {
    service: "poller-service",
    nodeId: "poller-runtime-node",
    role: "poller-service",
  });
  const runtimeMetricsInternals = runtimeMetricsPoller as unknown as {
    metricsSnapshot: () => unknown;
    publishRuntimeMetrics: (snapshot: unknown) => void;
  };
  runtimeMetricsInternals.publishRuntimeMetrics(runtimeMetricsInternals.metricsSnapshot());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtimeMetricsRequests.length, 1, "poller-service must publish runtime metrics");
  assert.equal(runtimeMetricsRequests[0]?.url, "http://notification-service.test/internal/runtime-metrics");

  console.log("poller-realtime-publisher: all assertions passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    Object.assign(mutableEnv, originalEnv);
  });
