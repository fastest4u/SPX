import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readGate6RuntimeContext,
  writeGate6RuntimeContext,
} from "../scripts/lib/gate6-runtime-context.mjs";

const H = (character: string): string => character.repeat(64);

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spx-gate6-context-"));
  await chmod(root, 0o700);
  const path = join(root, "runtime-context.json");
  const context = {
    schemaVersion: 1,
    gate6Id: "gate6-prod-001",
    candidateSha: "e".repeat(40),
    candidateImageDigest: `sha256:${H("a")}`,
    rollbackSha: "f".repeat(40),
    targetDescriptorSha256: H("b"),
    operatorBundleSha256: H("f"),
    monitorThresholdsSha256: H("c"),
    composeProject: "spx-production",
    envelopeSha256: H("d"),
    createdAt: "2026-07-11T02:00:00.000Z",
  };
  assert.deepEqual(await writeGate6RuntimeContext(context, { path, allowNonRoot: true }), context);
  assert.deepEqual(await readGate6RuntimeContext({ path, allowNonRoot: true }), context);
  assert.deepEqual(await writeGate6RuntimeContext(context, { path, allowNonRoot: true }), context);
  await assert.rejects(
    () => writeGate6RuntimeContext({ ...context, gate6Id: "gate6-prod-002" }, { path, allowNonRoot: true }),
    /conflict/i,
  );
  await mkdir(join(root, "bad"), { mode: 0o777 });
  console.log("Gate 6 runtime-context tests passed");
}

void main();
