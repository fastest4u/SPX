import {
  createRealtimeEnvelope,
  serializeSseEnvelope,
  type RealtimeEnvelopeV1,
  type RealtimeScope,
  type RealtimeSource,
} from "./realtime-contract.js";
import {
  getRealtimeEventByEventId,
  getRealtimeReplayHighWater,
  listRealtimeEventsForReplay,
  realtimeEventEnvelopeFromRow,
  type RealtimeEventRow,
} from "../repositories/realtime-event-repository.js";

export interface ReplayRealtimeEventsInput {
  scope: RealtimeScope;
  lastEventId?: string;
  limit?: number;
  source?: RealtimeSource;
  now?: Date;
  write: (chunk: string) => void | Promise<void>;
}

export interface ReplayRealtimeEventsAfterRowInput {
  scope: RealtimeScope;
  afterRowId?: number;
  throughRowId?: number;
  limit?: number;
  deliveredEventIds?: Set<string>;
  write: (chunk: string) => void | Promise<void>;
}

export interface ReplayRealtimeEventsUntilCaughtUpInput extends ReplayRealtimeEventsAfterRowInput {
  maxPasses?: number;
}

export interface ReplayRealtimeEventsResult {
  status: "none" | "replayed" | "resync-required";
  replayed: number;
  reason?: "cursor-missing" | "cursor-scope-mismatch";
  eventIds: string[];
  lastEventId?: string;
  lastRowId?: number;
  caughtUp?: boolean;
}

const defaultReplaySource: RealtimeSource = {
  service: "web-api",
  nodeId: "web-api",
  role: "web-api",
};

function scopesMatch(row: RealtimeEventRow, scope: RealtimeScope): boolean {
  if (scope.kind === "admin") return row.scopeKind === "admin" || row.scopeKind === "team";
  return row.scopeKind === "team" && row.teamId === scope.teamId;
}

function resyncSubject(scope: RealtimeScope): { type: string; id: string; teamId?: number | null } {
  if (scope.kind === "team") {
    return { type: "team", id: String(scope.teamId), teamId: scope.teamId };
  }
  return { type: "admin", id: "admin" };
}

function createResyncEnvelope(input: {
  scope: RealtimeScope;
  lastEventId: string;
  reason: "cursor-missing" | "cursor-scope-mismatch";
  source?: RealtimeSource;
  now?: Date;
}): RealtimeEnvelopeV1<unknown> {
  return createRealtimeEnvelope({
    type: "read-model.resync-required",
    payloadVersion: 1,
    payload: {
      reason: input.reason,
      lastEventId: input.lastEventId,
    },
    source: input.source ?? defaultReplaySource,
    scope: input.scope,
    subject: resyncSubject(input.scope),
    replayable: false,
    now: input.now,
  });
}

async function writeEnvelope(
  write: ReplayRealtimeEventsInput["write"],
  envelope: RealtimeEnvelopeV1<unknown>,
  options?: { resetLastEventId?: boolean },
): Promise<void> {
  await write(serializeSseEnvelope(envelope, options));
}

async function writeResyncRequired(input: {
  write: ReplayRealtimeEventsInput["write"];
  scope: RealtimeScope;
  lastEventId: string;
  reason: "cursor-missing" | "cursor-scope-mismatch";
  source?: RealtimeSource;
  now?: Date;
}): Promise<ReplayRealtimeEventsResult> {
  await writeEnvelope(input.write, createResyncEnvelope(input), { resetLastEventId: true });
  return { status: "resync-required", replayed: 0, reason: input.reason, eventIds: [] };
}

export async function replayRealtimeEventsFromCursor(
  input: ReplayRealtimeEventsInput,
): Promise<ReplayRealtimeEventsResult> {
  const lastEventId = input.lastEventId?.trim();
  if (!lastEventId) {
    return { status: "none", replayed: 0, eventIds: [] };
  }

  const cursor = await getRealtimeEventByEventId(lastEventId);
  if (!cursor) {
    return await writeResyncRequired({
      write: input.write,
      scope: input.scope,
      lastEventId,
      reason: "cursor-missing",
      source: input.source,
      now: input.now,
    });
  }

  if (!scopesMatch(cursor, input.scope)) {
    return await writeResyncRequired({
      write: input.write,
      scope: input.scope,
      lastEventId,
      reason: "cursor-scope-mismatch",
      source: input.source,
      now: input.now,
    });
  }

  const rows = await listRealtimeEventsForReplay({
    scope: input.scope,
    afterId: cursor.id,
    limit: input.limit,
  });
  for (const row of rows) {
    await writeEnvelope(input.write, realtimeEventEnvelopeFromRow(row));
  }

  const lastRow = rows.at(-1);
  const fallbackRow = rows.length === 0 ? cursor : undefined;
  return {
    status: rows.length > 0 ? "replayed" : "none",
    replayed: rows.length,
    eventIds: rows.map((row) => row.eventId),
    lastEventId: lastRow?.eventId ?? fallbackRow?.eventId,
    lastRowId: lastRow?.id ?? fallbackRow?.id,
  };
}

export async function replayRealtimeEventsAfterRowId(
  input: ReplayRealtimeEventsAfterRowInput,
): Promise<ReplayRealtimeEventsResult> {
  const highWater = input.throughRowId === undefined
    ? await getRealtimeReplayHighWater(input.scope)
    : { id: input.throughRowId, eventId: undefined };
  const throughRowId = highWater?.id;
  if (throughRowId === undefined) {
    return { status: "none", replayed: 0, eventIds: [], lastRowId: input.afterRowId };
  }

  let afterRowId = input.afterRowId ?? 0;
  if (afterRowId >= throughRowId) {
    return { status: "none", replayed: 0, eventIds: [], lastRowId: afterRowId };
  }

  const limit = input.limit ?? 500;
  const eventIds: string[] = [];
  let replayed = 0;
  let lastEventId: string | undefined;
  let lastRowId: number | undefined;

  while (afterRowId < throughRowId) {
    const rows = await listRealtimeEventsForReplay({
      scope: input.scope,
      afterId: afterRowId,
      throughId: throughRowId,
      limit,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!input.deliveredEventIds?.has(row.eventId)) {
        input.deliveredEventIds?.add(row.eventId);
        await writeEnvelope(input.write, realtimeEventEnvelopeFromRow(row));
        replayed += 1;
      }
      eventIds.push(row.eventId);
      lastEventId = row.eventId;
      lastRowId = row.id;
    }

    afterRowId = rows[rows.length - 1]!.id;
  }

  return {
    status: replayed > 0 ? "replayed" : "none",
    replayed,
    eventIds,
    lastEventId,
    lastRowId: lastRowId ?? afterRowId,
    caughtUp: true,
  };
}

export async function replayRealtimeEventsAfterRowIdUntilCaughtUp(
  input: ReplayRealtimeEventsUntilCaughtUpInput,
): Promise<ReplayRealtimeEventsResult> {
  const maxPasses = Math.max(1, input.maxPasses ?? 10);
  let afterRowId = input.afterRowId ?? 0;
  const eventIds: string[] = [];
  let replayed = 0;
  let lastEventId: string | undefined;
  let lastRowId: number | undefined = input.afterRowId;
  let caughtUp = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const passResult = await replayRealtimeEventsAfterRowId({
      ...input,
      afterRowId,
      throughRowId: undefined,
    });
    eventIds.push(...passResult.eventIds);
    replayed += passResult.replayed;
    if (passResult.lastEventId) lastEventId = passResult.lastEventId;

    const nextRowId = passResult.lastRowId ?? afterRowId;
    lastRowId = nextRowId;
    if (nextRowId <= afterRowId) {
      caughtUp = true;
      break;
    }
    afterRowId = nextRowId;
  }

  return {
    status: replayed > 0 ? "replayed" : "none",
    replayed,
    eventIds,
    lastEventId,
    lastRowId,
    caughtUp,
  };
}
