import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncE2EEStorageKeys } from "../src/services/line-bot.js";

async function run(): Promise<void> {
  const testDir = await mkdtemp(join(tmpdir(), "spx-line-e2ee-test-"));
  const storagePath = join(testDir, "linejs-storage.json");

  try {
    // Test 1: Graceful when file does not exist
    await syncE2EEStorageKeys(join(testDir, "nonexistent.json"), "u12345");

    // Test 2: Point selfMid to latest keyId and purge stale e2eeGroupKeys
    const initialStorage = {
      authToken: "sample-token",
      "e2eeKeys:5843820": { keyId: 5843820, privKey: "old-priv", pubKey: "old-pub" },
      "e2eeKeys:6030256": { keyId: 6030256, privKey: "new-priv", pubKey: "new-pub" },
      "e2eeKeys:u12345": { keyId: 5843820, privKey: "old-priv", pubKey: "old-pub" },
      "e2eeGroupKeys:c_group_1": { groupKey: "stale-group-key-1" },
      "e2eeGroupKeys:c_group_2": { groupKey: "stale-group-key-2" },
      otherSetting: "keep-this",
    };

    await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), "utf-8");
    await syncE2EEStorageKeys(storagePath, "u12345");

    const updatedRaw = await readFile(storagePath, "utf-8");
    const updated = JSON.parse(updatedRaw) as Record<string, unknown>;

    // Self key should now point to 6030256
    const selfKey = updated["e2eeKeys:u12345"] as { keyId: number; privKey: string };
    assert.equal(selfKey?.keyId, 6030256);
    assert.equal(selfKey?.privKey, "new-priv");

    // Stale group keys should be purged
    assert.equal("e2eeGroupKeys:c_group_1" in updated, false);
    assert.equal("e2eeGroupKeys:c_group_2" in updated, false);

    // Other keys preserved
    assert.equal(updated.authToken, "sample-token");
    assert.equal(updated.otherSetting, "keep-this");

    // Test 3: Idempotent when keys are already up to date
    await syncE2EEStorageKeys(storagePath, "u12345");
    const idempotenceRaw = await readFile(storagePath, "utf-8");
    const idempotent = JSON.parse(idempotenceRaw) as Record<string, unknown>;
    assert.deepEqual(idempotent, updated);

    console.log("line-bot-e2ee-sync: all assertions passed");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
