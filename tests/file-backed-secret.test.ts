import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileBackedSecret } from "../src/config/file-backed-secret.js";

const name = "SPX_TEST_FILE_BACKED_SECRET";
const fileName = `${name}_FILE`;
const temp = mkdtempSync(join(tmpdir(), "spx-file-backed-secret-"));
const secretPath = join(temp, "secret");

function reset(): void {
  delete process.env[name];
  delete process.env[fileName];
}

try {
  reset();
  assert.equal(loadFileBackedSecret(name), false);

  writeFileSync(secretPath, "  correct horse battery staple\n", { encoding: "utf8", mode: 0o600 });
  process.env[fileName] = secretPath;
  assert.equal(loadFileBackedSecret(name), true);
  assert.equal(process.env[name], "correct horse battery staple");
  assert.equal(
    process.env[fileName],
    secretPath,
    "the mounted file reference must remain available for isolation checks",
  );

  reset();
  process.env[name] = "plain-secret";
  process.env[fileName] = secretPath;
  assert.throws(() => loadFileBackedSecret(name), /mutually exclusive/);

  reset();
  const emptyPath = join(temp, "empty");
  writeFileSync(emptyPath, "\n", { encoding: "utf8", mode: 0o600 });
  process.env[fileName] = emptyPath;
  assert.throws(() => loadFileBackedSecret(name), /must not be empty/);

  reset();
  const marker = "SECRET_CONTENT_MUST_NOT_LEAK";
  process.env[fileName] = join(temp, marker);
  assert.throws(
    () => loadFileBackedSecret(name),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(marker));
      assert.doesNotMatch(message, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );

  reset();
  const directoryPath = join(temp, "directory-secret");
  mkdirSync(directoryPath);
  process.env[fileName] = directoryPath;
  assert.throws(() => loadFileBackedSecret(name), /could not be read/);
  assert.equal(process.env[name], undefined);

  reset();
  const oversizedPath = join(temp, "oversized-secret");
  writeFileSync(oversizedPath, Buffer.alloc(64 * 1024 + 1, 0x61), { mode: 0o600 });
  process.env[fileName] = oversizedPath;
  assert.throws(() => loadFileBackedSecret(name), /could not be read/);
  assert.equal(process.env[name], undefined);

  reset();
  const invalidUtf8Path = join(temp, "invalid-utf8-secret");
  writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  process.env[fileName] = invalidUtf8Path;
  assert.throws(() => loadFileBackedSecret(name), /could not be read/);
  assert.equal(process.env[name], undefined);

  reset();
  const symlinkTargetPath = join(temp, "symlink-target");
  const symlinkPath = join(temp, "symlink-secret");
  writeFileSync(symlinkTargetPath, "must-not-load", { encoding: "utf8", mode: 0o600 });
  try {
    symlinkSync(symlinkTargetPath, symlinkPath, "file");
    process.env[fileName] = symlinkPath;
    assert.throws(() => loadFileBackedSecret(name), /could not be read/);
    assert.equal(process.env[name], undefined);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
      throw error;
    }
  }
} finally {
  reset();
  rmSync(temp, { recursive: true, force: true });
}

console.log("file-backed-secret: loading and redaction verified");
