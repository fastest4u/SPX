process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "realtime-replay-test-key";

import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { getRealtimeEventByEventId, persistRealtimeEnvelope } from "../src/repositories/realtime-event-repository.js";
import { createRealtimeEnvelope, type RealtimeEnvelopeV1 } from "../src/services/realtime-contract.js";
import {
  replayRealtimeEventsAfterRowId,
  replayRealtimeEventsAfterRowIdUntilCaughtUp,
  replayRealtimeEventsFromCursor,
} from "../src/services/realtime-replay.js";
import { createPersistentRealtimePublisher, createSseRealtimeTransport } from "../src/services/realtime-publisher.js";
import { SseBroadcaster } from "../src/services/sse.js";

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

function teamEnvelope(id: string, teamId: number, total: number): RealtimeEnvelopeV1 {
  return createRealtimeEnvelope({
    id,
    type: "metrics.snapshot",
    payloadVersion: 1,
    payload: { total },
    source: { service: "worker", nodeId: `worker-${teamId}`, role: "worker" },
    scope: { kind: "team", teamId },
    subject: { type: "team", id: String(teamId), teamId },
    replayable: true,
    idempotencyKey: `metrics:${id}`,
    emittedAt: "2030-01-01T00:00:00.000Z",
    now: new Date("2030-01-01T00:00:01.000Z"),
  });
}

function adminEnvelope(id: string): RealtimeEnvelopeV1 {
  return createRealtimeEnvelope({
    id,
    type: "runtime.node.changed",
    payloadVersion: 1,
    payload: { active: 3 },
    source: { service: "web-api", nodeId: "web-api-1", role: "web-api" },
    scope: { kind: "admin" },
    replayable: true,
    idempotencyKey: `runtime:${id}`,
    emittedAt: "2030-01-01T00:00:02.000Z",
    now: new Date("2030-01-01T00:00:03.000Z"),
  });
}

function parseFrames(chunks: string[]): Array<{ event?: string; id?: string; data?: RealtimeEnvelopeV1 }> {
  return chunks.map((chunk) => {
    const frame: { event?: string; id?: string; data?: RealtimeEnvelopeV1 } = {};
    for (const line of chunk.trim().split("\n")) {
      if (line.startsWith("id: ")) frame.id = line.slice("id: ".length);
      if (line.startsWith("event: ")) frame.event = line.slice("event: ".length);
      if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice("data: ".length)) as RealtimeEnvelopeV1;
    }
    return frame;
  });
}

function fakeSseResponse(writes: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    response: {
      writableEnded: false,
      destroyed: false,
      writeHead(status: number) {
        writes.push(`status:${status}`);
      },
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      end() {
        writes.push("end");
      },
      on(event: string, handler: () => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      },
    },
    listeners,
  };
}

async function main(): Promise<void> {
  await resetDb();

  const cursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:cursor", 2, 1));
  const replayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:next", 2, 2));
  await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-3:next", 3, 3));
  await persistRealtimeEnvelope(adminEnvelope("runtime.node.changed:admin:next"));

  const chunks: string[] = [];
  const result = await replayRealtimeEventsFromCursor({
    scope: { kind: "team", teamId: 2 },
    lastEventId: cursor.row.eventId,
    write: (chunk) => chunks.push(chunk),
    now: new Date("2030-01-01T00:01:00.000Z"),
  });
  assert.equal(result.status, "replayed");
  assert.equal(result.replayed, 1);
  assert.deepEqual(result.eventIds, [replayed.row.eventId]);
  assert.equal(result.lastEventId, replayed.row.eventId);
  assert.equal(result.lastRowId, replayed.row.id);
  assert.deepEqual(parseFrames(chunks).map((frame) => frame.id), [replayed.row.eventId]);
  assert.deepEqual(parseFrames(chunks).map((frame) => frame.event), ["metrics.snapshot"]);
  assert.equal(parseFrames(chunks)[0]?.data?.scope.kind, "team");

  const adminChunks: string[] = [];
  const adminResult = await replayRealtimeEventsFromCursor({
    scope: { kind: "admin" },
    lastEventId: cursor.row.eventId,
    write: (chunk) => adminChunks.push(chunk),
    now: new Date("2030-01-01T00:01:00.000Z"),
  });
  assert.equal(adminResult.status, "replayed");
  assert.deepEqual(parseFrames(adminChunks).map((frame) => frame.id), [
    replayed.row.eventId,
    "metrics.snapshot:team-3:next",
    "runtime.node.changed:admin:next",
  ]);
  assert.equal(parseFrames(adminChunks)[0]?.data?.scope.kind, "team");
  assert.equal(parseFrames(adminChunks)[2]?.data?.scope.kind, "admin");

  const missingChunks: string[] = [];
  const missingResult = await replayRealtimeEventsFromCursor({
    scope: { kind: "team", teamId: 2 },
    lastEventId: "missing-event-id",
    write: (chunk) => missingChunks.push(chunk),
    now: new Date("2030-01-01T00:01:00.000Z"),
  });
  assert.equal(missingResult.status, "resync-required");
  assert.match(missingChunks[0] ?? "", /^id:\nevent: read-model\.resync-required\n/);
  assert.equal(parseFrames(missingChunks)[0]?.event, "read-model.resync-required");
  assert.equal(parseFrames(missingChunks)[0]?.data?.payload.reason, "cursor-missing");

  const missingCursorBroadcaster = new SseBroadcaster();
  const missingCursorWrites: string[] = [];
  const missingCursorResponse = fakeSseResponse(missingCursorWrites);
  const missingCursorAddResult = await missingCursorBroadcaster.addClient(
    missingCursorResponse.response,
    { teamId: 2 },
    {
      replay: async (write) => replayRealtimeEventsFromCursor({
        scope: { kind: "team", teamId: 2 },
        lastEventId: "missing-event-id",
        write: async (chunk) => {
          await write(chunk);
          missingCursorBroadcaster.broadcast({
            event: "live-after-resync-required",
            teamId: 2,
            data: { ok: true },
          });
        },
        now: new Date("2030-01-01T00:01:00.000Z"),
      }),
    },
  );
  assert.deepEqual(missingCursorAddResult, { accepted: false, reason: "closed" });
  assert.equal(missingCursorBroadcaster.clientCount, 0);
  assert.equal(
    missingCursorWrites.filter((chunk) => chunk.includes("event: read-model.resync-required")).length,
    1,
    "semantic resync must not emit a duplicate control frame",
  );
  assert.equal(
    missingCursorWrites.some((chunk) => chunk.includes("live-after-resync-required")),
    false,
    "semantic resync must not flush buffered live events",
  );
  assert.equal(missingCursorWrites.at(-1), "end");
  missingCursorBroadcaster.closeAll();

  const noCursorChunks: string[] = [];
  const noCursorResult = await replayRealtimeEventsFromCursor({
    scope: { kind: "team", teamId: 2 },
    write: (chunk) => noCursorChunks.push(chunk),
  });
  assert.equal(noCursorResult.status, "none");
  assert.equal(noCursorChunks.length, 0);

  await resetDb();
  const raceCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:race-cursor", 2, 1));
  const raceReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:race-replayed", 2, 2));
  const acceptedDuringReplay = teamEnvelope("metrics.snapshot:team-2:accepted-during-replay", 2, 3);
  const raceBroadcaster = new SseBroadcaster();
  const racePublisher = createPersistentRealtimePublisher(createSseRealtimeTransport(raceBroadcaster));
  const raceWrites: string[] = [];
  const raceResponse = fakeSseResponse(raceWrites);
  let publishedDuringReplay = false;
  let publishedDuringReplayId = "";

  const raceAddResult = await raceBroadcaster.addClient(raceResponse.response, { teamId: 2 }, {
    replay: async (write) => {
      const replayResult = await replayRealtimeEventsFromCursor({
        scope: { kind: "team", teamId: 2 },
        lastEventId: raceCursor.row.eventId,
        write: async (chunk) => {
          await write(chunk);
          if (!publishedDuringReplay) {
            publishedDuringReplay = true;
            const published = await racePublisher.publish(acceptedDuringReplay);
            publishedDuringReplayId = published.id;
          }
        },
      });
      return replayResult;
    },
  });
  assert.deepEqual(raceAddResult, { accepted: true });
  assert.ok(await getRealtimeEventByEventId(publishedDuringReplayId));

  assert.deepEqual(parseFrames(raceWrites).map((frame) => frame.id).filter(Boolean), [
    raceReplayed.row.eventId,
    publishedDuringReplayId,
  ]);
  raceBroadcaster.closeAll();

  await resetDb();
  const persistedOnlyCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:persisted-only-cursor", 2, 1));
  const persistedOnlyReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:persisted-only-replayed", 2, 2));
  const persistedOnlyDuringReplay = teamEnvelope("metrics.snapshot:team-2:persisted-only-during-replay", 2, 3);
  const persistedOnlyBroadcaster = new SseBroadcaster();
  const persistedOnlyWrites: string[] = [];
  const persistedOnlyResponse = fakeSseResponse(persistedOnlyWrites);
  let persistedDuringReplay = false;

  const persistedOnlyAddResult = await persistedOnlyBroadcaster.addClient(
    persistedOnlyResponse.response,
    { teamId: 2 },
    {
      replay: async (write) => {
        return await replayRealtimeEventsFromCursor({
          scope: { kind: "team", teamId: 2 },
          lastEventId: persistedOnlyCursor.row.eventId,
          write: async (chunk) => {
          await write(chunk);
            if (!persistedDuringReplay) {
              persistedDuringReplay = true;
              await persistRealtimeEnvelope(persistedOnlyDuringReplay);
            }
          },
        });
      },
      afterReplay: async (write, replayResult) => {
        if (typeof replayResult?.lastRowId !== "number") return undefined;
        return await replayRealtimeEventsAfterRowId({
          scope: { kind: "team", teamId: 2 },
          afterRowId: replayResult.lastRowId,
          write,
        });
      },
    },
  );
  assert.deepEqual(persistedOnlyAddResult, { accepted: true });
  assert.deepEqual(parseFrames(persistedOnlyWrites).map((frame) => frame.id).filter(Boolean), [
    persistedOnlyReplayed.row.eventId,
    persistedOnlyDuringReplay.id,
  ]);
  persistedOnlyBroadcaster.closeAll();

  await resetDb();
  const postHighWaterCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:post-high-water-cursor", 2, 1));
  const postHighWaterReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:post-high-water-replayed", 2, 2));
  const firstCatchupRow = teamEnvelope("metrics.snapshot:team-2:first-catchup-row", 2, 3);
  const postHighWaterBeforeLive = teamEnvelope("metrics.snapshot:team-2:post-high-water-before-live", 2, 4);
  const postStableBeforeLive = teamEnvelope("metrics.snapshot:team-2:post-stable-before-live", 2, 5);
  const postHighWaterBroadcaster = new SseBroadcaster();
  const postHighWaterWrites: string[] = [];
  const postHighWaterResponse = fakeSseResponse(postHighWaterWrites);
  let persistedFirstCatchup = false;
  let persistedAfterFirstHighWater = false;

  const postHighWaterAddResult = await postHighWaterBroadcaster.addClient(
    postHighWaterResponse.response,
    { teamId: 2 },
    {
      replay: async (write) => {
        return await replayRealtimeEventsFromCursor({
          scope: { kind: "team", teamId: 2 },
          lastEventId: postHighWaterCursor.row.eventId,
          write: async (chunk) => {
          await write(chunk);
            if (!persistedFirstCatchup) {
              persistedFirstCatchup = true;
              await persistRealtimeEnvelope(firstCatchupRow);
            }
          },
        });
      },
      afterReplay: async (write, replayResult, context) => {
        if (typeof replayResult?.lastRowId !== "number") return undefined;
        const catchupResult = await replayRealtimeEventsAfterRowIdUntilCaughtUp({
          scope: { kind: "team", teamId: 2 },
          afterRowId: replayResult.lastRowId,
          deliveredEventIds: context.deliveredEventIds,
          write: async (chunk) => {
          await write(chunk);
            const id = parseFrames([chunk])[0]?.id;
            if (id === firstCatchupRow.id && !persistedAfterFirstHighWater) {
              persistedAfterFirstHighWater = true;
              await persistRealtimeEnvelope(postHighWaterBeforeLive);
            }
          },
        });
        await persistRealtimeEnvelope(postStableBeforeLive);
        return catchupResult;
      },
    },
  );
  assert.deepEqual(postHighWaterAddResult, { accepted: true });
  assert.deepEqual(parseFrames(postHighWaterWrites).map((frame) => frame.id).filter(Boolean), [
    postHighWaterReplayed.row.eventId,
    firstCatchupRow.id,
    postHighWaterBeforeLive.id,
    postStableBeforeLive.id,
  ]);
  postHighWaterBroadcaster.closeAll();

  await resetDb();
  const catchupOrderCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:catchup-order-cursor", 2, 1));
  const catchupOrderReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:catchup-order-replayed", 2, 2));
  const catchupOrderBacklog = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:catchup-order-backlog", 2, 3));
  const catchupOrderLive = teamEnvelope("metrics.snapshot:team-2:catchup-order-live", 2, 4);
  const catchupOrderBroadcaster = new SseBroadcaster();
  const catchupOrderPublisher = createPersistentRealtimePublisher(createSseRealtimeTransport(catchupOrderBroadcaster));
  const catchupOrderWrites: string[] = [];
  const catchupOrderResponse = fakeSseResponse(catchupOrderWrites);
  let publishedBeforeCatchup = false;

  const catchupOrderAddResult = await catchupOrderBroadcaster.addClient(
    catchupOrderResponse.response,
    { teamId: 2 },
    {
      replay: async (write) => {
        return await replayRealtimeEventsFromCursor({
          scope: { kind: "team", teamId: 2 },
          lastEventId: catchupOrderCursor.row.eventId,
          limit: 1,
          write,
        });
      },
      afterReplay: async (write, replayResult, context) => {
        if (typeof replayResult?.lastRowId !== "number") return undefined;
        if (!publishedBeforeCatchup) {
          publishedBeforeCatchup = true;
          await catchupOrderPublisher.publish(catchupOrderLive);
        }
        return await replayRealtimeEventsAfterRowIdUntilCaughtUp({
          scope: { kind: "team", teamId: 2 },
          afterRowId: replayResult.lastRowId,
          deliveredEventIds: context.deliveredEventIds,
          write,
        });
      },
    },
  );
  assert.deepEqual(catchupOrderAddResult, { accepted: true });
  assert.deepEqual(parseFrames(catchupOrderWrites).map((frame) => frame.id).filter(Boolean), [
    catchupOrderReplayed.row.eventId,
    catchupOrderBacklog.row.eventId,
    catchupOrderLive.id,
  ]);
  catchupOrderBroadcaster.closeAll();

  await resetDb();
  const bufferedCatchupCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:buffered-catchup-cursor", 2, 1));
  const bufferedCatchupReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:buffered-catchup-replayed", 2, 2));
  const bufferedAndCaughtUp = teamEnvelope("metrics.snapshot:team-2:buffered-and-caught-up", 2, 3);
  const bufferedCatchupBroadcaster = new SseBroadcaster();
  const bufferedCatchupPublisher = createPersistentRealtimePublisher(createSseRealtimeTransport(bufferedCatchupBroadcaster));
  const bufferedCatchupWrites: string[] = [];
  const bufferedCatchupResponse = fakeSseResponse(bufferedCatchupWrites);
  let publishedBufferedCatchup = false;

  const bufferedCatchupAddResult = await bufferedCatchupBroadcaster.addClient(
    bufferedCatchupResponse.response,
    { teamId: 2 },
    {
      replay: async (write) => {
        return await replayRealtimeEventsFromCursor({
          scope: { kind: "team", teamId: 2 },
          lastEventId: bufferedCatchupCursor.row.eventId,
          write: async (chunk) => {
          await write(chunk);
            if (!publishedBufferedCatchup) {
              publishedBufferedCatchup = true;
              await bufferedCatchupPublisher.publish(bufferedAndCaughtUp);
            }
          },
        });
      },
      afterReplay: async (write, replayResult, context) => {
        if (typeof replayResult?.lastRowId !== "number") return undefined;
        return await replayRealtimeEventsAfterRowIdUntilCaughtUp({
          scope: { kind: "team", teamId: 2 },
          afterRowId: replayResult.lastRowId,
          deliveredEventIds: context.deliveredEventIds,
          write,
        });
      },
    },
  );
  assert.deepEqual(bufferedCatchupAddResult, { accepted: true });
  assert.deepEqual(parseFrames(bufferedCatchupWrites).map((frame) => frame.id).filter(Boolean), [
    bufferedCatchupReplayed.row.eventId,
    bufferedAndCaughtUp.id,
  ]);
  bufferedCatchupBroadcaster.closeAll();

  await resetDb();
  const limitedCatchupCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:limited-cursor", 2, 1));
  const limitedCatchupFirst = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:limited-first", 2, 2));
  const limitedCatchupSecond = teamEnvelope("metrics.snapshot:team-2:limited-second", 2, 3);
  const limitedCatchupWrites: string[] = [];
  let persistedLimitedSecond = false;
  const limitedCatchupResult = await replayRealtimeEventsAfterRowIdUntilCaughtUp({
    scope: { kind: "team", teamId: 2 },
    afterRowId: limitedCatchupCursor.row.id,
    maxPasses: 1,
    write: async (chunk) => {
      limitedCatchupWrites.push(chunk);
      if (!persistedLimitedSecond) {
        persistedLimitedSecond = true;
        await persistRealtimeEnvelope(limitedCatchupSecond);
      }
    },
  });
  assert.equal(limitedCatchupResult.caughtUp, false);
  assert.equal(limitedCatchupResult.lastRowId, limitedCatchupFirst.row.id);
  assert.deepEqual(parseFrames(limitedCatchupWrites).map((frame) => frame.id).filter(Boolean), [
    limitedCatchupFirst.row.eventId,
  ]);

  await resetDb();
  const adminRaceCursor = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:admin-race-cursor", 2, 1));
  const adminRaceReplayed = await persistRealtimeEnvelope(teamEnvelope("metrics.snapshot:team-2:admin-race-replayed", 2, 2));
  const adminVisibleDuringReplay = teamEnvelope("metrics.snapshot:team-3:admin-visible-during-replay", 3, 3);
  const adminRaceBroadcaster = new SseBroadcaster();
  const adminRaceWrites: string[] = [];
  const adminRaceResponse = fakeSseResponse(adminRaceWrites);
  let adminPublishedDuringReplay = false;

  const adminRaceAddResult = await adminRaceBroadcaster.addClient(
    adminRaceResponse.response,
    { teamId: null },
    {
      replay: async (write) => {
        return await replayRealtimeEventsFromCursor({
          scope: { kind: "admin" },
          lastEventId: adminRaceCursor.row.eventId,
          write: async (chunk) => {
          await write(chunk);
            if (!adminPublishedDuringReplay) {
              adminPublishedDuringReplay = true;
              await persistRealtimeEnvelope(adminVisibleDuringReplay);
            }
          },
        });
      },
      afterReplay: async (write, replayResult) => {
        if (typeof replayResult?.lastRowId !== "number") return undefined;
        return await replayRealtimeEventsAfterRowId({
          scope: { kind: "admin" },
          afterRowId: replayResult.lastRowId,
          write,
        });
      },
    },
  );
  assert.deepEqual(adminRaceAddResult, { accepted: true });
  assert.deepEqual(parseFrames(adminRaceWrites).map((frame) => frame.id).filter(Boolean), [
    adminRaceReplayed.row.eventId,
    adminVisibleDuringReplay.id,
  ]);
  adminRaceBroadcaster.closeAll();

  const broadcaster = new SseBroadcaster();
  const writes: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const fakeResponse = {
    writableEnded: false,
    destroyed: false,
    writeHead(status: number) {
      writes.push(`status:${status}`);
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      writes.push("end");
    },
    on(event: string, handler: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    },
  };

  await broadcaster.addClient(fakeResponse, { teamId: 2 }, {
    replay: async (write) => {
      await write("event: replayed\ndata: {}\n\n");
    },
  });
  assert.equal(broadcaster.clientCount, 1);
  broadcaster.broadcast({ event: "live", teamId: 2, data: { ok: true } });
  assert.deepEqual(writes.slice(0, 5), [
    "status:200",
    ": connected\n\n",
    "retry: 5000\n\n",
    "event: replayed\ndata: {}\n\n",
    'event: live\ndata: {"teamId":2,"event":"live","data":{"ok":true}}\n\n',
  ]);
  broadcaster.closeAll();

  const replayFailureBroadcaster = new SseBroadcaster();
  const replayFailureWrites: string[] = [];
  const replayFailureResponse = {
    writableEnded: false,
    destroyed: false,
    writeHead(status: number) {
      replayFailureWrites.push(`status:${status}`);
    },
    write(chunk: string) {
      replayFailureWrites.push(chunk);
      return true;
    },
    end() {
      replayFailureWrites.push("end");
    },
    on() {
      // Test double does not need close propagation.
    },
  };
  const replayFailureResult = await replayFailureBroadcaster.addClient(replayFailureResponse, { teamId: 2 }, {
    resyncSource: { service: "realtime-service", nodeId: "realtime-1", role: "realtime-service" },
    replay: async () => {
      throw new Error("replay unavailable");
    },
  });
  assert.deepEqual(replayFailureResult, { accepted: false, reason: "closed" });
  assert.equal(replayFailureBroadcaster.clientCount, 0);
  replayFailureBroadcaster.broadcast({ event: "live-after-replay-error", teamId: 2, data: { ok: true } });
  assert.equal(replayFailureWrites.some((chunk) => chunk.includes("read-model.resync-required")), true);
  assert.equal(replayFailureWrites.some((chunk) => chunk.includes('"service":"realtime-service"')), true);
  assert.deepEqual(replayFailureWrites.slice(0, 3), [
    "status:200",
    ": connected\n\n",
    "retry: 5000\n\n",
  ]);
  assert.equal(replayFailureWrites.some((chunk) => chunk.includes("live-after-replay-error")), false);
  replayFailureBroadcaster.closeAll();

  const catchupFailureBroadcaster = new SseBroadcaster();
  const catchupFailureWrites: string[] = [];
  const catchupFailureResponse = fakeSseResponse(catchupFailureWrites);
  const catchupFailureAddResult = await catchupFailureBroadcaster.addClient(
    catchupFailureResponse.response,
    { teamId: 2 },
    {
      replay: () => ({ eventIds: [], lastRowId: 1 }),
      afterReplay: async () => {
        throw new Error("catchup unavailable");
      },
    },
  );
  assert.deepEqual(catchupFailureAddResult, { accepted: false, reason: "closed" });
  assert.equal(catchupFailureBroadcaster.clientCount, 0);
  assert.equal(catchupFailureWrites.at(-1), "end");
  catchupFailureBroadcaster.closeAll();

  const catchupIncompleteBroadcaster = new SseBroadcaster();
  const catchupIncompleteWrites: string[] = [];
  const catchupIncompleteResponse = fakeSseResponse(catchupIncompleteWrites);
  const catchupIncompleteAddResult = await catchupIncompleteBroadcaster.addClient(
    catchupIncompleteResponse.response,
    { teamId: 2 },
    {
      replay: () => ({ eventIds: [], lastRowId: 1 }),
      afterReplay: () => ({ eventIds: [], lastRowId: 1, caughtUp: false }),
    },
  );
  assert.deepEqual(catchupIncompleteAddResult, { accepted: false, reason: "closed" });
  assert.equal(catchupIncompleteBroadcaster.clientCount, 0);
  assert.equal(catchupIncompleteWrites.at(-1), "end");
  catchupIncompleteBroadcaster.closeAll();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
