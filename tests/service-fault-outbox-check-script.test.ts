import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts", "service-fault-outbox-check.mjs");

type ScriptResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DB_HOST: "",
        DB_USERNAME: "",
        DB_PASSWORD: "",
        DB_NAME: "",
        DB_MODE: "mysql",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("exit", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const fixture = JSON.stringify([
    { status: "failed", count: 2, attempted: 2, minAttempts: 1, maxAttempts: 3 },
    { status: "sent", count: 5, attempted: 5, minAttempts: 1, maxAttempts: 1 },
  ]);
  const cleanSentFixture = JSON.stringify([
    { status: "sent", count: 5, attempted: 0, minAttempts: 0, maxAttempts: 0 },
  ]);

  const help = await runScript(["--help"], {
    DB_HOST: "db-host-should-not-print",
    DB_USERNAME: "db-user-should-not-print",
    DB_PASSWORD: "db-password-should-not-print",
    DB_NAME: "db-name-should-not-print",
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /service-fault-outbox-check\.mjs/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--since-minutes=<minutes>/);
  assert.match(help.stdout, /--event-key-contains=<event-key>/);
  assert.match(help.stdout, /metadata-only|aggregate/i);
  assert.doesNotMatch(
    help.stdout,
    /db-host-should-not-print|db-user-should-not-print|db-password-should-not-print|db-name-should-not-print|fault_drill_secret_event_key/,
  );

  const success = await runScript([
    `--fixture-json=${fixture}`,
    "--expect-failed-attempt",
    "--max-pending=2",
  ]);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const successOutput = JSON.parse(success.stdout);
  assert.equal(successOutput.ok, true);
  assert.equal(successOutput.mode, "fixture");
  assert.equal(successOutput.summary.failedAttempts, 2);
  assert.equal(successOutput.summary.retriedRows, 7);
  assert.equal(successOutput.summary.pending, 2);
  assert.equal(successOutput.summary.sent, 5);
  assert.deepEqual(successOutput.expectationFailures, []);
  assert.doesNotMatch(success.stdout, /target|payload|message|secret|password/i);

  const minTotalAndSent = await runScript([
    `--fixture-json=${cleanSentFixture}`,
    "--min-total=1",
    "--expect-sent",
  ]);
  assert.equal(minTotalAndSent.status, 0, minTotalAndSent.stderr || minTotalAndSent.stdout);
  const minTotalAndSentOutput = JSON.parse(minTotalAndSent.stdout);
  assert.equal(minTotalAndSentOutput.expectations.minTotal, 1);
  assert.equal(minTotalAndSentOutput.expectations.expectSent, true);
  assert.deepEqual(minTotalAndSentOutput.expectationFailures, []);

  const sentAfterRetry = await runScript([
    `--fixture-json=${JSON.stringify([{ status: "sent", count: 1, attempted: 1 }])}`,
    "--min-total=1",
    "--expect-sent",
  ]);
  assert.equal(sentAfterRetry.status, 1, sentAfterRetry.stdout);
  const sentAfterRetryOutput = JSON.parse(sentAfterRetry.stdout);
  assert.deepEqual(sentAfterRetryOutput.expectationFailures, [
    "unexpected-failed-attempt-present",
  ]);

  const missingSent = await runScript([
    `--fixture-json=${JSON.stringify([{ status: "queued", count: 1, attempted: 0 }])}`,
    "--expect-sent",
  ]);
  assert.equal(missingSent.status, 1, missingSent.stdout);
  const missingSentOutput = JSON.parse(missingSent.stdout);
  assert.deepEqual(missingSentOutput.expectationFailures, ["expected-sent-missing"]);

  const missingTotal = await runScript([`--fixture-json=${JSON.stringify([])}`, "--min-total=1"]);
  assert.equal(missingTotal.status, 1, missingTotal.stdout);
  const missingTotalOutput = JSON.parse(missingTotal.stdout);
  assert.deepEqual(missingTotalOutput.expectationFailures, ["total-count-below-threshold"]);

  const filtered = await runScript([
    `--fixture-json=${fixture}`,
    "--event-key-contains=fault_drill_secret_event_key",
  ]);
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  const filteredOutput = JSON.parse(filtered.stdout);
  assert.equal(filteredOutput.ok, true);
  assert.equal(filteredOutput.filters.eventKeyContains, true);
  assert.equal(
    filteredOutput.filters.eventKeyContainsSha256,
    sha256("fault_drill_secret_event_key"),
  );
  assert.doesNotMatch(filtered.stdout, /fault_drill_secret_event_key/);

  const dryRun = await runScript(
    [
      "--dry-run",
      "--since-minutes=30",
      "--event-key-contains=fault_drill_secret_event_key",
      "--min-total=1",
      "--expect-sent",
      "--max-pending=0",
    ],
    {
      DB_HOST: "db-host-value",
      DB_USERNAME: "db-user-value",
      DB_PASSWORD: "super-secret-db-password",
      DB_NAME: "db-name-value",
      DB_MODE: "mysql",
    },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  const dryRunOutput = JSON.parse(dryRun.stdout);
  assert.equal(dryRunOutput.ok, true);
  assert.equal(dryRunOutput.mode, "dry-run");
  assert.equal(dryRunOutput.dryRun, true);
  assert.equal(dryRunOutput.sinceMinutes, 30);
  assert.equal(dryRunOutput.filters.eventKeyContains, true);
  assert.equal(dryRunOutput.filters.eventKeyContainsSha256, sha256("fault_drill_secret_event_key"));
  assert.deepEqual(dryRunOutput.expectations, {
    minTotal: 1,
    expectSent: true,
    expectFailedAttempt: false,
    maxPending: 0,
  });
  assert.deepEqual(dryRunOutput.missingDbEnv, []);
  assert.deepEqual(dryRunOutput.expectationFailures, []);
  assert.equal("summary" in dryRunOutput, false);
  assert.doesNotMatch(
    dryRun.stdout,
    /fault_drill_secret_event_key|db-host-value|db-user-value|super-secret-db-password|db-name-value/,
  );

  const dryRunMissingEventKey = await runScript(["--dry-run", "--since-minutes=30"], {
    DB_HOST: "db-host-value",
    DB_USERNAME: "db-user-value",
    DB_PASSWORD: "super-secret-db-password",
    DB_NAME: "db-name-value",
    DB_MODE: "mysql",
  });
  assert.equal(dryRunMissingEventKey.status, 1, dryRunMissingEventKey.stdout);
  const dryRunMissingEventKeyOutput = JSON.parse(dryRunMissingEventKey.stdout);
  assert.equal(dryRunMissingEventKeyOutput.reason, "missing-config");
  assert.deepEqual(dryRunMissingEventKeyOutput.missingConfig, ["--event-key-contains"]);
  assert.equal(dryRunMissingEventKeyOutput.filters.eventKeyContains, false);
  assert.equal(dryRunMissingEventKeyOutput.filters.eventKeyContainsSha256, null);
  assert.equal("summary" in dryRunMissingEventKeyOutput, false);
  assert.doesNotMatch(
    dryRunMissingEventKey.stdout,
    /db-host-value|db-user-value|super-secret-db-password|db-name-value/,
  );

  const dryRunMissingDbEnv = await runScript(
    ["--dry-run", "--event-key-contains=fault_drill_secret_event_key"],
    {
      DB_HOST: "db-host-value",
      DB_PASSWORD: "super-secret-db-password",
    },
  );
  assert.equal(dryRunMissingDbEnv.status, 1, dryRunMissingDbEnv.stdout);
  const dryRunMissingDbEnvOutput = JSON.parse(dryRunMissingDbEnv.stdout);
  assert.equal(dryRunMissingDbEnvOutput.mode, "dry-run");
  assert.deepEqual(dryRunMissingDbEnvOutput.missingDbEnv, ["DB_USERNAME", "DB_NAME"]);
  assert.doesNotMatch(dryRunMissingDbEnv.stdout, /db-host-value|super-secret-db-password/);

  const dryRunMemoryMode = await runScript(
    ["--dry-run", "--event-key-contains=fault_drill_secret_event_key"],
    {
      DB_HOST: "db-host-value",
      DB_USERNAME: "db-user-value",
      DB_PASSWORD: "super-secret-db-password",
      DB_NAME: "db-name-value",
      DB_MODE: "memory",
    },
  );
  assert.equal(dryRunMemoryMode.status, 1, dryRunMemoryMode.stdout);
  const dryRunMemoryModeOutput = JSON.parse(dryRunMemoryMode.stdout);
  assert.deepEqual(dryRunMemoryModeOutput.missingDbEnv, [
    "DB_MODE=mysql required for live outbox probe",
  ]);
  assert.doesNotMatch(dryRunMemoryMode.stdout, /db-host-value|super-secret-db-password/);

  const pendingFailure = await runScript([`--fixture-json=${fixture}`, "--max-pending=1"]);
  assert.equal(pendingFailure.status, 1, pendingFailure.stdout);
  const pendingFailureOutput = JSON.parse(pendingFailure.stdout);
  assert.equal(pendingFailureOutput.ok, false);
  assert.deepEqual(pendingFailureOutput.expectationFailures, ["pending-count-above-threshold"]);

  const missingFailedAttempt = await runScript([
    `--fixture-json=${JSON.stringify([{ status: "queued", count: 1, attempted: 0 }])}`,
    "--expect-failed-attempt",
  ]);
  assert.equal(missingFailedAttempt.status, 1, missingFailedAttempt.stdout);
  const missingFailedAttemptOutput = JSON.parse(missingFailedAttempt.stdout);
  assert.deepEqual(missingFailedAttemptOutput.expectationFailures, [
    "expected-failed-attempt-missing",
  ]);

  const liveMissingEventKey = await runScript([], {
    DB_HOST: "db-host-value",
    DB_USERNAME: "db-user-value",
    DB_PASSWORD: "super-secret-db-password",
    DB_NAME: "db-name-value",
    DB_MODE: "memory",
  });
  assert.equal(liveMissingEventKey.status, 1, liveMissingEventKey.stdout);
  const liveMissingEventKeyOutput = JSON.parse(liveMissingEventKey.stdout);
  assert.equal(liveMissingEventKeyOutput.reason, "missing-config");
  assert.deepEqual(liveMissingEventKeyOutput.missingConfig, ["--event-key-contains"]);
  assert.equal(liveMissingEventKeyOutput.filters.eventKeyContains, false);
  assert.equal(liveMissingEventKeyOutput.filters.eventKeyContainsSha256, null);
  assert.equal("summary" in liveMissingEventKeyOutput, false);
  assert.doesNotMatch(
    liveMissingEventKey.stdout,
    /db-host-value|db-user-value|super-secret-db-password|db-name-value/,
  );

  const missingDbEnv = await runScript(["--event-key-contains=fault_drill_secret_event_key"], {
    DB_HOST: "db-host-value",
    DB_PASSWORD: "super-secret-db-password",
  });
  assert.equal(missingDbEnv.status, 1, missingDbEnv.stdout);
  const missingDbEnvOutput = JSON.parse(missingDbEnv.stdout);
  assert.deepEqual(missingDbEnvOutput.missingDbEnv, ["DB_USERNAME", "DB_NAME"]);
  assert.doesNotMatch(missingDbEnv.stdout, /db-host-value|super-secret-db-password/);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
