import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const serverUrl = new URL(baseUrl);
const serverPort = Number(serverUrl.port || (serverUrl.protocol === "https:" ? 443 : 80));
const serverBinary = resolve(process.cwd(), "dist/app.js");

async function assertOk(url: string, label: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.ok) {
        return;
      }
      throw new Error(`${label} failed with status ${res.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < 20) {
        await delay(500);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

async function waitForServer(): Promise<() => Promise<void>> {
  try {
    await assertOk(`${baseUrl}/health`, "/health");
    return async () => undefined;
  } catch {
    const child = spawn(process.execPath, [serverBinary], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HTTP_ENABLED: "true",
        HTTP_PORT: String(serverPort),
      },
      stdio: "inherit",
    });

    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    };

    try {
      await assertOk(`${baseUrl}/health`, "/health");
      return stop;
    } catch (error) {
      await stop();
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const stopServer = await waitForServer();

  try {
    await assertOk(`${baseUrl}/ready`, "/ready");
    await assertOk(`${baseUrl}/health`, "/health");

    const indexHtmlPath = resolve(process.cwd(), "dist/public/index.html");
    const indexContent = await readFile(indexHtmlPath, "utf8");
    if (!indexContent.includes("root") || !indexContent.includes("SPX")) {
      throw new Error("index.html asset is missing expected content");
    }

    // Verify SPA catch-all serves index.html for client-side routes
    const spaRes = await fetch(`${baseUrl}/history`, { redirect: "manual" });
    if (!spaRes.ok) {
      throw new Error(`SPA catch-all /history failed with status ${spaRes.status}`);
    }

    console.log(JSON.stringify({
      ready: true,
      health: true,
      spaIndex: true,
      baseUrl,
    }, null, 2));
  } finally {
    await stopServer();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
