import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SecretModule = {
  resolveFileBackedSecret: (name: string, env?: Record<string, string | undefined>) => string;
};

const name = "SPX_SCRIPT_TEST_SECRET";
const fileName = `${name}_FILE`;
const secretValue = "script-secret-value-must-not-leak";

async function main(): Promise<void> {
  const { resolveFileBackedSecret } =
    (await import("../scripts/lib/file-backed-secret.mjs")) as SecretModule;
  const temp = mkdtempSync(join(tmpdir(), "spx-script-file-backed-secret-"));
  const secretPath = join(temp, "secret-value");

  function assertSanitizedFailure(env: Record<string, string | undefined>): void {
    assert.throws(
      () => resolveFileBackedSecret(name, env),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message, "file-backed-secret-invalid");
        assert.doesNotMatch(message, /SPX_SCRIPT_TEST_SECRET|secret-value|must-not-leak/);
        assert.doesNotMatch(message, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  }

  try {
    assert.equal(resolveFileBackedSecret(name, {}), "");
    assert.equal(resolveFileBackedSecret(name, { [name]: `  ${secretValue}\n` }), secretValue);

    writeFileSync(secretPath, `  ${secretValue}\n`, { encoding: "utf8", mode: 0o600 });
    assert.equal(resolveFileBackedSecret(name, { [fileName]: secretPath }), secretValue);

    assertSanitizedFailure({ [name]: secretValue, [fileName]: secretPath });
    assertSanitizedFailure({ [fileName]: join(temp, "missing-secret-must-not-leak") });

    const directoryPath = join(temp, "directory-secret");
    mkdirSync(directoryPath);
    assertSanitizedFailure({ [fileName]: directoryPath });

    const oversizedPath = join(temp, "oversized-secret");
    writeFileSync(oversizedPath, Buffer.alloc(64 * 1024 + 1, 0x61), { mode: 0o600 });
    assertSanitizedFailure({ [fileName]: oversizedPath });

    const invalidUtf8Path = join(temp, "invalid-utf8-secret");
    writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    assertSanitizedFailure({ [fileName]: invalidUtf8Path });

    const emptyPath = join(temp, "empty-secret");
    writeFileSync(emptyPath, "\n", { encoding: "utf8", mode: 0o600 });
    assertSanitizedFailure({ [fileName]: emptyPath });

    const symlinkTargetPath = join(temp, "symlink-target");
    const symlinkPath = join(temp, "symlink-secret");
    writeFileSync(symlinkTargetPath, secretValue, { encoding: "utf8", mode: 0o600 });
    try {
      symlinkSync(symlinkTargetPath, symlinkPath, "file");
      assertSanitizedFailure({ [fileName]: symlinkPath });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
        throw error;
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("script-file-backed-secret: bounded file loading and redaction verified"))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
