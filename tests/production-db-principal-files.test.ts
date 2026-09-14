import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalGate6Json } from "../src/services/gate6-approval-runtime.mjs";
import { createProductionDbCredentialAdapter } from "../scripts/lib/production-db-principal-files.mjs";

const H = (character: string): string => character.repeat(64);
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spx-db-principal-"));
  await chmod(root, 0o700);
  const roleRoot = join(root, "line-service");
  await mkdir(roleRoot, { mode: 0o700 });
  const candidate = "CandidatePassword_base64url_00000001";
  const legacy = "LegacyPassword_base64url_0000000002";
  await writeFile(join(roleRoot, "candidate-password"), candidate, { mode: 0o600 });
  await writeFile(join(roleRoot, "legacy-password"), legacy, { mode: 0o600 });
  await writeFile(join(roleRoot, "binding.json"), canonicalGate6Json({
    schemaVersion: 1,
    role: "line-service",
    targetDescriptorSha256: H("a"),
    accountHost: "mysql.production.example",
    candidateUsername: "spx_line",
    legacyUsername: "spx_legacy",
    candidatePasswordSha256: sha(candidate),
    legacyPasswordSha256: sha(legacy),
    positiveGrantProofSha256: H("b"),
    forbiddenGrantProofSha256: H("c"),
  }), { mode: 0o600 });
  const dockerCalls: string[] = [];
  const adapter = createProductionDbCredentialAdapter({
    root,
    allowNonRoot: true,
    targetDescriptorSha256: H("a"),
    docker: {
      async isRunning() { return false; },
      async recreate(service: string) { dockerCalls.push(service); },
      async isReady() { return true; },
    },
  });
  await adapter.prepareRestricted({ role: "line-service", accountHost: "mysql.production.example" });
  assert.equal(await adapter.verifyPrepared({ role: "line-service", accountHost: "mysql.production.example" }), true);
  await adapter.stageCredential({ role: "line-service", accountHost: "mysql.production.example" });
  assert.equal((await adapter.captureBaseline({ role: "line-service" })).mode, "candidate");
  await adapter.restoreCredential({ role: "line-service" });
  assert.equal((await adapter.captureBaseline({ role: "line-service" })).mode, "legacy");
  assert.deepEqual(dockerCalls, []);
  console.log("production DB-principal file adapter tests passed");
}

void main();
