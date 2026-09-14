import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "spx-file-backed-env-"));
const dbPasswordPath = join(temp, "db-password");
const secretsKeyPath = join(temp, "secrets-key");

async function main(): Promise<void> {
  try {
    writeFileSync(dbPasswordPath, "db-password-from-file\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(secretsKeyPath, "s".repeat(32), { encoding: "utf8", mode: 0o600 });
    delete process.env.DB_PASSWORD;
    delete process.env.SECRETS_KEY;
    process.env.DB_PASSWORD_FILE = dbPasswordPath;
    process.env.SECRETS_KEY_FILE = secretsKeyPath;
    process.chdir(temp);

    const { env } = await import("../src/config/env.js");
    assert.equal(env.DB_PASSWORD, "db-password-from-file");
    assert.equal(env.SECRETS_KEY, "s".repeat(32));
  } finally {
    process.chdir(originalCwd);
    delete process.env.DB_PASSWORD;
    delete process.env.DB_PASSWORD_FILE;
    delete process.env.SECRETS_KEY;
    delete process.env.SECRETS_KEY_FILE;
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

main()
  .then(() => console.log("file-backed-secret-env: runtime config loads mounted secrets first"))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
