import assert from "node:assert/strict";
import { closePool } from "../src/db/client.js";
import { resetMemoryDb } from "../src/db/client-memory.js";
import {
  listRuntimeNodes,
  upsertRuntimeNode,
} from "../src/repositories/runtime-repository.js";
import { acquireTeamLease } from "../src/services/runtime-lease.js";
import type { RuntimeReleaseIdentity } from "../src/services/runtime-release-identity.js";

async function resetDb(): Promise<void> {
  await closePool();
  resetMemoryDb();
}

async function nodeMetadata(nodeId: string): Promise<string | null> {
  return (await listRuntimeNodes()).find((row) => row.nodeId === nodeId)?.metadataJson ?? null;
}

async function main(): Promise<void> {
  await resetDb();

  const metadata = {
    assignedTeamIds: [1, 2],
    enabledLoopModes: ["poller"],
  };
  await upsertRuntimeNode({
    nodeId: "poller-node-1",
    role: "poller-service",
    metadata,
  });
  assert.deepEqual(JSON.parse((await nodeMetadata("poller-node-1")) ?? "null"), metadata);

  await upsertRuntimeNode({
    nodeId: "poller-node-1",
    role: "poller-service",
    hostname: "lease-host",
    pid: 1234,
  });
  assert.deepEqual(JSON.parse((await nodeMetadata("poller-node-1")) ?? "null"), metadata);

  const lease = await acquireTeamLease({
    teamId: 1,
    nodeId: "poller-node-1",
    role: "poller-service",
    ttlMs: 30_000,
    now: new Date("2030-01-01T00:00:00.000Z"),
  });
  assert.equal(lease.acquired, true);
  assert.deepEqual(JSON.parse((await nodeMetadata("poller-node-1")) ?? "null"), metadata);

  const releaseIdentity = {
    version: "1.0.0",
    gitSha: "a".repeat(40),
    buildId: "run-123",
    environment: "production",
    topology: "split",
    imageId: `sha256:${"b".repeat(64)}`,
    imageTag: `spx-app:${"a".repeat(40)}`,
    targetDescriptorSha256: "c".repeat(64),
    operatorBundleSha256: "d".repeat(64),
  } satisfies RuntimeReleaseIdentity;
  const releaseLease = await acquireTeamLease({
    teamId: 2,
    nodeId: "worker-release-node",
    role: "worker",
    ttlMs: 30_000,
    now: new Date("2030-01-01T00:00:00.000Z"),
    releaseIdentity,
    startedAt: "2026-07-11T01:00:00.000Z",
  });
  assert.equal(releaseLease.acquired, true);
  const releaseNode = (await listRuntimeNodes()).find((row) => row.nodeId === "worker-release-node");
  assert.equal(releaseNode?.version, "1.0.0");
  assert.deepEqual(JSON.parse(releaseNode?.metadataJson ?? "null"), {
    gitSha: "a".repeat(40),
    buildId: "run-123",
    environment: "production",
    topology: "split",
    imageId: `sha256:${"b".repeat(64)}`,
    imageTag: `spx-app:${"a".repeat(40)}`,
    targetDescriptorSha256: "c".repeat(64),
    operatorBundleSha256: "d".repeat(64),
    startedAt: "2026-07-11T01:00:00.000Z",
  });

  await upsertRuntimeNode({
    nodeId: "node-without-metadata",
    role: "worker",
  });
  assert.equal(await nodeMetadata("node-without-metadata"), null);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
