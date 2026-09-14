import assert from "node:assert/strict";
import { createRealtimeEnvelope } from "../src/services/realtime-contract.js";
import { SseBroadcaster } from "../src/services/sse.js";

type HeaderMap = Record<string, string>;

type FakeSseResponse = {
  response: {
    writableEnded: boolean;
    destroyed: boolean;
    writeHead(status: number, headerMap: HeaderMap): void;
    write(chunk: string): boolean;
    end(chunk?: string): void;
    on(event: string, handler: () => void): void;
  };
  writes: string[];
  statuses: number[];
  headers: HeaderMap[];
  listeners: Map<string, Array<() => void>>;
  emit(event: string): void;
  endCount(): number;
};

function fakeResponse(writeResults: boolean[] = []): FakeSseResponse {
  const writes: string[] = [];
  const statuses: number[] = [];
  const headers: HeaderMap[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let ends = 0;

  return {
    response: {
      writableEnded: false,
      destroyed: false,
      writeHead(status: number, headerMap: HeaderMap) {
        statuses.push(status);
        headers.push(headerMap);
      },
      write(chunk: string) {
        writes.push(chunk);
        return writeResults.shift() ?? true;
      },
      end(chunk?: string) {
        if (chunk) writes.push(chunk);
        ends += 1;
        writes.push("end");
      },
      on(event: string, handler: () => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      },
    },
    writes,
    statuses,
    headers,
    listeners,
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    endCount: () => ends,
  };
}

function manualTimers() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    callbacks,
    setTimeout(callback: () => void, _delay: number) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id as never;
    },
    clearTimeout(id: unknown) {
      callbacks.delete(Number(id));
    },
    runOnlyTimer() {
      const entry = callbacks.entries().next();
      assert.equal(entry.done, false, "expected a scheduled timeout");
      const [id, callback] = entry.value!;
      callbacks.delete(id);
      callback();
    },
  };
}

async function main(): Promise<void> {
  const broadcaster = new SseBroadcaster({ maxClients: 1 });
  const first = fakeResponse();
  const second = fakeResponse();

  const firstResult = await broadcaster.addClient(first.response as never, { teamId: 2 });
  const secondResult = await broadcaster.addClient(second.response as never, { teamId: 3 });

  assert.deepEqual(firstResult, { accepted: true });
  assert.deepEqual(secondResult, { accepted: false, reason: "capacity" });
  assert.equal(broadcaster.clientCount, 1);
  assert.deepEqual(first.statuses, [200]);
  assert.equal(first.writes.includes("end"), false, "existing client must not be evicted");
  assert.deepEqual(second.statuses, [429]);
  assert.equal(second.headers[0]?.["Content-Type"], "application/json");
  assert.match(second.writes.join(""), /SSE connection limit exceeded/);

  broadcaster.broadcast({ event: "live", teamId: 2, data: { ok: true } });
  assert.match(first.writes.join(""), /event: live/);
  assert.doesNotMatch(second.writes.join(""), /event: live/);
  broadcaster.closeAll();

  const preflightBroadcaster = new SseBroadcaster();
  const preflightClient = fakeResponse();
  let releasePreflight: (() => void) | undefined;
  const preflightPending = new Promise<void>((resolve) => { releasePreflight = resolve; });
  const preflightAdd = preflightBroadcaster.addClient(preflightClient.response as never, { teamId: 2 }, {
    preflight: async () => await preflightPending,
  });
  assert.deepEqual(preflightClient.statuses, [], "preflight must complete before SSE headers");
  preflightBroadcaster.broadcast({ event: "preflight-race", teamId: 2, data: { ok: true } });
  releasePreflight?.();
  assert.deepEqual(await preflightAdd, { accepted: true });
  assert.deepEqual(preflightClient.statuses, [200]);
  assert.match(preflightClient.writes.join(""), /event: preflight-race/);
  preflightBroadcaster.closeAll();

  const preflightOverflowBroadcaster = new SseBroadcaster({ maxReplayBufferChunks: 1 });
  const preflightOverflowClient = fakeResponse();
  let releaseOverflowPreflight: (() => void) | undefined;
  const overflowPreflightPending = new Promise<void>((resolve) => { releaseOverflowPreflight = resolve; });
  const preflightOverflowAdd = preflightOverflowBroadcaster.addClient(
    preflightOverflowClient.response as never,
    { teamId: 2 },
    { preflight: async () => await overflowPreflightPending },
  );
  preflightOverflowBroadcaster.broadcast({ event: "preflight-overflow-one", teamId: 2, data: {} });
  preflightOverflowBroadcaster.broadcast({ event: "preflight-overflow-two", teamId: 2, data: {} });
  assert.deepEqual(preflightOverflowClient.statuses, [], "overflow must not bypass preflight headers");
  assert.deepEqual(preflightOverflowClient.writes, [], "overflow must not write a control frame before preflight");
  releaseOverflowPreflight?.();
  assert.deepEqual(await preflightOverflowAdd, { accepted: false, reason: "closed" });
  assert.deepEqual(preflightOverflowClient.statuses, [200]);
  assert.match(preflightOverflowClient.writes.join(""), /read-model\.resync-required/);
  preflightOverflowBroadcaster.closeAll();

  const canonicalBroadcaster = new SseBroadcaster();
  const canonicalClient = fakeResponse();
  await canonicalBroadcaster.addClient(canonicalClient.response as never, { teamId: 2 });
  const envelope = createRealtimeEnvelope({
    id: "metrics.snapshot:team-2:live",
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: { total: 44 },
    source: { service: "worker", nodeId: "worker-2", role: "worker" },
    scope: { kind: "team", teamId: 2 },
    subject: { type: "team", id: "2", teamId: 2 },
    replayable: true,
    idempotencyKey: "metrics:team-2:live",
    emittedAt: "2030-01-01T00:00:00.000Z",
    now: new Date("2030-01-01T00:00:01.000Z"),
  });
  canonicalBroadcaster.broadcastEnvelope(envelope);
  const frame = canonicalClient.writes.join("");
  assert.match(frame, /id: metrics\.snapshot:team-2:live/);
  assert.match(frame, /event: metrics\.snapshot/);
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine);
  assert.deepEqual(JSON.parse(dataLine.slice("data: ".length)), JSON.parse(JSON.stringify(envelope)));
  canonicalBroadcaster.closeAll();

  const disconnectDuringReplayBroadcaster = new SseBroadcaster({ maxClients: 1 });
  const disconnectingClient = fakeResponse();
  const disconnectResult = await disconnectDuringReplayBroadcaster.addClient(
    disconnectingClient.response as never,
    { teamId: 2 },
    {
      replay: async () => {
        disconnectingClient.response.destroyed = true;
        disconnectingClient.emit("close");
      },
    },
  );
  assert.deepEqual(disconnectResult, { accepted: false, reason: "closed" });
  assert.equal(disconnectDuringReplayBroadcaster.clientCount, 0);
  disconnectDuringReplayBroadcaster.closeAll();

  const drainTimers = manualTimers();
  const drainBroadcaster = new SseBroadcaster({
    setTimeout: drainTimers.setTimeout,
    clearTimeout: drainTimers.clearTimeout,
  });
  const drainClient = fakeResponse([true, true, false, true]);
  await drainBroadcaster.addClient(drainClient.response as never, { teamId: 2 });
  assert.match(drainClient.writes.join(""), /: connected\n\nretry: 5000\n\n/);
  drainBroadcaster.broadcast({ event: "first-live", teamId: 2, data: { first: true } });
  assert.equal(drainTimers.callbacks.size, 1);
  drainClient.emit("drain");
  assert.equal(drainTimers.callbacks.size, 0);
  drainBroadcaster.broadcast({ event: "second-live", teamId: 2, data: { second: true } });
  assert.match(drainClient.writes.join(""), /event: second-live/);
  assert.equal(drainClient.endCount(), 0);
  drainBroadcaster.closeAll();

  const missedTimers = manualTimers();
  const missedBroadcaster = new SseBroadcaster({
    setTimeout: missedTimers.setTimeout,
    clearTimeout: missedTimers.clearTimeout,
  });
  const missedClient = fakeResponse([true, true, false, true]);
  await missedBroadcaster.addClient(missedClient.response as never, { teamId: 2 });
  missedBroadcaster.broadcast({ event: "blocked-live", teamId: 2, data: { first: true } });
  missedBroadcaster.broadcast({ event: "missed-live", teamId: 2, data: { second: true } });
  const missedFrames = missedClient.writes.join("");
  assert.doesNotMatch(missedFrames, /event: missed-live/);
  assert.match(missedFrames, /id:\nevent: read-model\.resync-required/);
  assert.equal(missedClient.endCount(), 1);
  assert.equal(missedBroadcaster.clientCount, 0);

  const timeoutTimers = manualTimers();
  const timeoutBroadcaster = new SseBroadcaster({
    setTimeout: timeoutTimers.setTimeout,
    clearTimeout: timeoutTimers.clearTimeout,
  });
  const timeoutClient = fakeResponse([true, true, false, true]);
  await timeoutBroadcaster.addClient(timeoutClient.response as never, { teamId: 2 });
  timeoutBroadcaster.broadcast({ event: "timeout-live", teamId: 2, data: { ok: true } });
  timeoutTimers.runOnlyTimer();
  assert.match(timeoutClient.writes.join(""), /id:\nevent: read-model\.resync-required/);
  assert.equal(timeoutClient.endCount(), 1);
  timeoutClient.emit("drain");
  assert.equal(timeoutClient.endCount(), 1);
  assert.equal(timeoutBroadcaster.clientCount, 0);

  const errorTimers = manualTimers();
  const errorBroadcaster = new SseBroadcaster({
    setTimeout: errorTimers.setTimeout,
    clearTimeout: errorTimers.clearTimeout,
  });
  const errorClient = fakeResponse([true, true, false]);
  await errorBroadcaster.addClient(errorClient.response as never, { teamId: 2 });
  errorBroadcaster.broadcast({ event: "error-live", teamId: 2, data: { ok: true } });
  errorClient.emit("error");
  errorClient.emit("close");
  assert.equal(errorTimers.callbacks.size, 0);
  assert.equal(errorClient.endCount(), 0);
  assert.equal(errorBroadcaster.clientCount, 0);

  const replayTimers = manualTimers();
  const replayBroadcaster = new SseBroadcaster({
    setTimeout: replayTimers.setTimeout,
    clearTimeout: replayTimers.clearTimeout,
  });
  const replayClient = fakeResponse([true, true, false, true]);
  await replayBroadcaster.addClient(replayClient.response as never, { teamId: 2 }, {
    replay: async (write) => {
      await write("event: replay-one\ndata: {}\n\n");
      await write("event: replay-two\ndata: {}\n\n");
    },
  });
  const replayFrames = replayClient.writes.join("");
  assert.match(replayFrames, /event: replay-one/);
  assert.doesNotMatch(replayFrames, /event: replay-two/);
  assert.match(replayFrames, /id:\nevent: read-model\.resync-required/);
  assert.equal(replayClient.endCount(), 1);

  const overflowBroadcaster = new SseBroadcaster({ maxReplayBufferChunks: 1 });
  const overflowClient = fakeResponse();
  let releaseReplay: (() => void) | undefined;
  const replayPending = new Promise<void>((resolve) => { releaseReplay = resolve; });
  const overflowAdd = overflowBroadcaster.addClient(overflowClient.response as never, { teamId: 2 }, {
    replay: async () => await replayPending,
  });
  overflowBroadcaster.broadcast({ event: "race-one", teamId: 2, data: { one: true } });
  overflowBroadcaster.broadcast({ event: "race-two", teamId: 2, data: { two: true } });
  assert.match(overflowClient.writes.join(""), /id:\nevent: read-model\.resync-required/);
  assert.equal(overflowClient.endCount(), 1);
  releaseReplay?.();
  assert.deepEqual(await overflowAdd, { accepted: false, reason: "closed" });
  assert.equal(overflowBroadcaster.clientCount, 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
