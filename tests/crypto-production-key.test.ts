import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const tsxRegisterUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const ownedFixture = mkdtempSync(join(tmpdir(), "spx-crypto-production-key-"));
process.on("exit", () => rmSync(ownedFixture, { recursive: true, force: true }));
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const jwtSecret = "jwt-fallback-value-that-must-never-leak";
const cookieSecret = "cookie-fallback-value-that-must-never-leak";

function runEncryption(secretsKey: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      tsxRegisterUrl,
      "--input-type=module",
      "--eval",
      [
        `import { encryptString } from ${JSON.stringify(pathToFileURL(resolve("src/utils/crypto.ts")).href)};`,
        "try { encryptString('production-secret'); process.exit(0); }",
        "catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(42); }",
      ].join(" "),
    ],
    {
      cwd: ownedFixture,
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        SECRETS_KEY: secretsKey,
        JWT_SECRET: jwtSecret,
        COOKIE_SECRET: cookieSecret,
        PATH: process.env.PATH ?? "",
        Path: process.env.Path ?? "",
        PATHEXT: process.env.PATHEXT ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
      },
    },
  );
}

for (const invalidKey of ["", "short"]) {
  const result = runEncryption(invalidKey);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 42, output);
  assert.match(output, /SECRETS_KEY.*at least 32/);
  assert.doesNotMatch(output, new RegExp(jwtSecret));
  assert.doesNotMatch(output, new RegExp(cookieSecret));
}

const valid = runEncryption("x".repeat(32));
assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
