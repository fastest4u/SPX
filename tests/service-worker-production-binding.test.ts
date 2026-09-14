import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { canonicalJson } from "../scripts/lib/evidence-artifact.mjs";

const productionBinding = {
  candidateSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  releaseManifestSha256: "c".repeat(64),
  environment: "supervised-production",
  topology: "split",
  composeProject: "spx-production",
  targetDescriptorSha256: "d".repeat(64),
  operatorBundleSha256: "e".repeat(64),
  productionIdentityApprovalSha256: "f".repeat(64),
};

const root = mkdtempSync(join(tmpdir(), "spx-production-worker-binding-"));
try {
  const preload = join(root, "preload.mjs");
  const evidenceDir = join(root, "evidence");
  writeFileSync(
    preload,
    "globalThis.__SPX_TEST_INSTALLED_RELEASE_BINDING__ = JSON.parse(process.env.SPX_TEST_RELEASE_BINDING_JSON);\n",
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/service-worker-evidence-check.mjs"),
      `--init-dir=${evidenceDir}`,
      "--environment=supervised-production",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        SPX_TEST_RELEASE_BINDING_JSON: canonicalJson(productionBinding),
      },
    },
  );
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const metadata = JSON.parse(readFileSync(join(evidenceDir, "drill-metadata.json"), "utf8"));
  assert.equal(metadata.payload.environment, "supervised-production");
  assert.deepEqual(metadata.releaseBinding, productionBinding);
} finally {
  rmSync(root, { recursive: true, force: true });
}
