import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";

async function assertOk(url: string, label: string): Promise<void> {
  const res = await fetch(url, { redirect: "manual" });
  if (!res.ok) {
    throw new Error(`${label} failed with status ${res.status}`);
  }
}

async function main(): Promise<void> {
  await assertOk(`${baseUrl}/ready`, "/ready");
  await assertOk(`${baseUrl}/health`, "/health");

  const assetsPath = resolve(process.cwd(), "dist/public/dashboard.js");
  const assetContent = await readFile(assetsPath, "utf8");
  if (!assetContent.includes("window.logout")) {
    throw new Error("dashboard.js asset is missing expected content");
  }

  const assetRes = await fetch(`${baseUrl}/assets/dashboard.js`, { redirect: "manual" });
  if (!assetRes.ok) {
    throw new Error(`/assets/dashboard.js failed with status ${assetRes.status}`);
  }

  console.log(JSON.stringify({
    ready: true,
    health: true,
    asset: true,
    baseUrl,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
