import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxRegisterUrl = pathToFileURL(require.resolve("tsx")).href;
const dryRunLoopUrl = pathToFileURL(
  resolve(process.cwd(), "src/services/auto-accept-job-dry-run-loop.ts"),
).href;
const childScript = `
  const { startAutoAcceptJobDryRunWorkerLoop } = await import(${JSON.stringify(dryRunLoopUrl)});
  const emptySummary = () => ({
    claimed: 0,
    succeeded: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    retried: 0,
    deadLettered: 0,
    executorErrors: 0,
    settleFailures: 0,
    checkpointed: 0,
    checkpointFailures: 0,
  });
  const shared = {
    nodeId: "auto-accept-lifecycle",
    teamIds: [2],
    batchSize: 1,
    leaseMs: 1000,
    intervalMs: 60000,
    runBatch: async () => emptySummary(),
  };
  const loop = startAutoAcceptJobDryRunWorkerLoop(shared);
  console.log("READY");
  const stopTimer = setTimeout(() => {
    loop.stop();
    console.log("STOPPED");
  }, 250);
  stopTimer.unref();
`;

async function main(): Promise<void> {
  for (const file of [
    "src/services/auto-accept-job-dry-run-loop.ts",
    "src/services/auto-accept-job-real-execution-loop.ts",
    "src/services/auto-accept-job-settlement-loop.ts",
  ]) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /timer\.unref/, `${file} must own a referenced lifecycle timer`);
  }

  const child = spawn(
    process.execPath,
    ["--import", tsxRegisterUrl, "--input-type=module", "-e", childScript],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_MODE: "memory",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`lifecycle child timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.equal(exitResult.code, 0, stderr);
  assert.equal(exitResult.signal, null, stderr);
  assert.match(stdout, /READY/);
  assert.match(
    stdout,
    /STOPPED/,
    "referenced worker-loop timers must keep an auto-accept-only process alive until stop() clears them",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
