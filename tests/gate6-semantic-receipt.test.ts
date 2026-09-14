import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGate6SemanticReceipt,
  readGate6SemanticReceipt,
  semanticReceiptPathForScope,
  writeGate6SemanticReceipt,
} from "../scripts/lib/gate6-semantic-receipt.mjs";

const H = (character: string): string => character.repeat(64);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function validReceiptInput() {
  const checkerOutput = { ok: true, phase: "db-transition" };
  return {
    gate6Id: "gate6-prod-001",
    scope: "stage-accept-db-transition",
    actionId: "stage-db-001",
    expectedStage: "admitted",
    nextStage: "db-transition-stable",
    checkerName: "db-transition-production-evidence",
    checkerExecutableSha256: H("1"),
    checkerArgumentsSha256: H("2"),
    checkerOutputSha256: sha256(canonicalJson(checkerOutput)),
    checkerOutput,
    checkedAt: "2026-07-16T02:00:00.000Z",
  };
}

test("builds an exact non-self-referential semantic checker receipt", () => {
  const receipt = buildGate6SemanticReceipt(validReceiptInput());
  assert.deepEqual(Object.keys(receipt).sort(), [
    "acceptedCheckerSha256",
    "actionId",
    "checkedAt",
    "checkerArgumentsSha256",
    "checkerExecutableSha256",
    "checkerName",
    "checkerOutput",
    "checkerOutputSha256",
    "expectedStage",
    "gate6Id",
    "nextStage",
    "schemaVersion",
    "scope",
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(
    receipt.acceptedCheckerSha256,
    sha256(
      canonicalJson({
        schemaVersion: 1,
        gate6Id: receipt.gate6Id,
        scope: receipt.scope,
        actionId: receipt.actionId,
        expectedStage: receipt.expectedStage,
        nextStage: receipt.nextStage,
        checkerName: receipt.checkerName,
        checkerExecutableSha256: receipt.checkerExecutableSha256,
        checkerArgumentsSha256: receipt.checkerArgumentsSha256,
        checkerOutputSha256: receipt.checkerOutputSha256,
      }),
    ),
  );
  assert.equal(canonicalJson(receipt).includes(receipt.acceptedCheckerSha256), true);
});

test("writes one canonical root-private receipt and retries only identical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spx-gate6-semantic-"));
  try {
    const receipt = buildGate6SemanticReceipt(validReceiptInput());
    const first = await writeGate6SemanticReceipt(receipt, { root });
    assert.equal(first.path, join(root, "stage-accept-db-transition.json"));
    const bytes = await readFile(first.path);
    assert.equal(bytes.toString("utf8"), canonicalJson(receipt));
    assert.equal(first.sha256, sha256(bytes));
    if (process.platform !== "win32") {
      assert.equal((await lstat(first.path)).mode & 0o777, 0o400);
    }
    assert.deepEqual(await readGate6SemanticReceipt(receipt.scope, { root }), {
      receipt,
      path: first.path,
      sha256: first.sha256,
    });
    assert.deepEqual(await writeGate6SemanticReceipt(receipt, { root }), first);

    const conflictingOutput = { ok: true, phase: "different" };
    const conflicting = buildGate6SemanticReceipt({
      ...validReceiptInput(),
      checkerOutputSha256: sha256(canonicalJson(conflictingOutput)),
      checkerOutput: conflictingOutput,
    });
    await assert.rejects(
      writeGate6SemanticReceipt(conflicting, { root }),
      /conflict|identical|changed/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source keeps no-follow exclusive creation plus file and parent durability barriers", async () => {
  const source = await readFile(
    new URL("../scripts/lib/gate6-semantic-receipt.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /constants\.O_CREAT\s*\|\s*constants\.O_EXCL/);
  assert.match(source, /constants\.O_NOFOLLOW/);
  assert.match(source, /await handle\.sync\(\)/);
  assert.match(source, /await fsyncDirectory\(root\)/);
  assert.match(source, /isSymbolicLink\(\)/);
});

test("rejects unsupported scope, unsafe permissions, and a symlink receipt", async (t) => {
  assert.throws(() => semanticReceiptPathForScope("stage-accept-unknown", "/tmp/fixed"), /scope/i);

  const root = await mkdtemp(join(tmpdir(), "spx-gate6-semantic-"));
  try {
    const receipt = buildGate6SemanticReceipt(validReceiptInput());
    const path = semanticReceiptPathForScope(receipt.scope, root);
    const target = join(root, "target.json");
    await writeGate6SemanticReceipt(receipt, { root });
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
      await assert.rejects(
        writeGate6SemanticReceipt(receipt, { root }),
        /mode|permission|private/i,
      );
    }
    await rm(path, { force: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, Buffer.from(canonicalJson(receipt)), { mode: 0o400 });
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("file symlinks require an elevated Windows token");
        return;
      }
      throw error;
    }
    await assert.rejects(writeGate6SemanticReceipt(receipt, { root }), /symlink|regular/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
