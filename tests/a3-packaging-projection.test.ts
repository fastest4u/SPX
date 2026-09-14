import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPERATOR_BUNDLE_STATIC_FILES,
  buildOperatorBundle,
  materializeOperatorBundle,
  verifyOperatorBundle,
} from "../scripts/build-operator-bundle.mjs";

const temp = mkdtempSync(join(tmpdir(), "spx-a3-projection-"));
const root = join(temp, "source");
const out = join(temp, "out");
mkdirSync(out, { recursive: true });
function put(path: string, content: string) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
try {
  for (const path of OPERATOR_BUNDLE_STATIC_FILES) put(path, `fixture:${path}\n`);
  const migration = "SELECT 1;\n";
  put("migrations/001_fixture.sql", migration);
  put("migrations/released-checksums.json", JSON.stringify({
    "001_fixture.sql": createHash("sha256").update(migration).digest("hex"),
  }));
  const archivePath = join(out, "candidate.tar");
  const indexPath = join(out, "candidate.index.json");
  buildOperatorBundle({ root, archivePath, indexPath, topology: "a3" });
  const installed = join(temp, "installed");
  materializeOperatorBundle({ root: installed, archivePath, indexPath });
  assert.equal(readFileSync(join(root, "docker-compose.yml"), "utf8"), "fixture:docker-compose.yml\n");
  assert.equal(readFileSync(join(root, "Dockerfile"), "utf8"), "fixture:Dockerfile\n");
  assert.equal(readFileSync(join(installed, "docker-compose.yml"), "utf8"), "fixture:docker-compose.a3.yml\n");
  assert.equal(readFileSync(join(installed, "Dockerfile"), "utf8"), "fixture:Dockerfile.a3\n");
  assert.doesNotThrow(() => verifyOperatorBundle({ root: installed, archivePath, indexPath }));
  chmodSync(join(installed, "docker-compose.yml"), 0o644);
  writeFileSync(join(installed, "docker-compose.yml"), "tampered canonical topology\n");
  assert.throws(() => verifyOperatorBundle({ root: installed, archivePath, indexPath }), /mismatch/);
  console.log("A3 candidate projection preserves released source and verifies exact installed bytes");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
