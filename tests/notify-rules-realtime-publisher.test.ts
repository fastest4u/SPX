process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "notify-rules-realtime-test-key";

import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import { createTeam } from "../src/repositories/team-repository.js";
import type { RealtimePublishInput, RealtimePublishResult, RealtimePublisher, RealtimeSource } from "../src/services/realtime-contract.js";
import type { LegacyRealtimeEvent } from "../src/services/realtime-publisher.js";
import {
  configureNotifyRulesRealtime,
  createRule,
  deleteRule,
  readRules,
  resetNotifyRulesRealtime,
  updateRule,
} from "../src/services/notify-rules.js";
import { logger } from "../src/utils/logger.js";

class CapturingPublisher implements RealtimePublisher {
  inputs: RealtimePublishInput[] = [];
  legacy: LegacyRealtimeEvent[] = [];
  async publish<T>(input: RealtimePublishInput<T>): Promise<RealtimePublishResult> {
    this.inputs.push(input);
    return { accepted: true, duplicate: false, id: `rules-${this.inputs.length}`, receivedAt: new Date().toISOString(), persisted: false };
  }
  async publishSnapshot<T>(input: RealtimePublishInput<T>): Promise<RealtimePublishResult> {
    return this.publish(input);
  }
  publishLegacy(event: LegacyRealtimeEvent): void {
    this.legacy.push(event);
  }
}

class ThrowingPublisher extends CapturingPublisher {
  override async publish<T>(_input: RealtimePublishInput<T>): Promise<RealtimePublishResult> {
    throw new Error("publisher-secret-must-not-leak");
  }
}

const source: RealtimeSource = { service: "web-api", nodeId: "web-rules-1", role: "api" };

async function main(): Promise<void> {
  await closePool();
  resetMemoryDb();
  const team = await createTeam({ name: "Rules Team", spxCookie: "cookie", spxDeviceId: "device", enabled: true });

  const publisher = new CapturingPublisher();
  configureNotifyRulesRealtime({ publisher, source });
  const created = await createRule(team.id, { name: "A > B", origins: ["A"], destinations: ["B"], need: 2 });
  const updated = await updateRule(team.id, created.id, { need: 3 });
  const deleted = await deleteRule(team.id, created.id);
  assert.equal(updated?.need, 3);
  assert.equal(deleted?.id, created.id);
  assert.equal(publisher.inputs.length, 3);
  assert.deepEqual(publisher.inputs.map((event) => event.type), ["rules.changed", "rules.changed", "rules.changed"]);
  for (const event of publisher.inputs) {
    assert.equal(event.payloadVersion, 1);
    assert.deepEqual(event.scope, { kind: "team", teamId: team.id });
    assert.deepEqual(event.subject, { type: "rules", id: String(team.id), teamId: team.id });
    assert.deepEqual(event.source, source);
    assert.equal(event.replayable, false);
  }
  assert.deepEqual(publisher.legacy.map((event) => ({ event: event.event, teamId: event.teamId })), [
    { event: "rules", teamId: team.id },
    { event: "rules", teamId: team.id },
    { event: "rules", teamId: team.id },
  ]);
  assert.deepEqual(publisher.inputs.map((event) => (event.payload as unknown[]).length), [1, 1, 0]);

  const warningCalls: Array<{ message: string; metadata: unknown }> = [];
  const originalWarn = logger.warn;
  logger.warn = ((message: string, metadata?: unknown) => {
    warningCalls.push({ message, metadata });
  }) as typeof logger.warn;
  try {
    configureNotifyRulesRealtime({ publisher: new ThrowingPublisher(), source });
    const failOpenCreated = await createRule(team.id, { name: "Fail open", need: 1 });
    assert.ok(failOpenCreated.id);
    const failOpenUpdated = await updateRule(team.id, failOpenCreated.id, { enabled: false });
    assert.equal(failOpenUpdated?.enabled, false);
    const failOpenDeleted = await deleteRule(team.id, failOpenCreated.id);
    assert.equal(failOpenDeleted?.id, failOpenCreated.id);
    assert.equal((await readRules(team.id)).some((rule) => rule.id === failOpenCreated.id), false);
  } finally {
    logger.warn = originalWarn;
    resetNotifyRulesRealtime();
    await closePool();
  }
  assert.equal(warningCalls.length, 3);
  assert.equal(JSON.stringify(warningCalls).includes("publisher-secret-must-not-leak"), false);
  assert.deepEqual(warningCalls.map((call) => call.message), [
    "notify-rules-realtime-publish-failed",
    "notify-rules-realtime-publish-failed",
    "notify-rules-realtime-publish-failed",
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
