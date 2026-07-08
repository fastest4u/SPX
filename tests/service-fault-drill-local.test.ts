import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { env } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { createHttpServer } from "../src/services/http-server.js";
import type { HttpSurface } from "../src/services/runtime-role.js";

type App = Awaited<ReturnType<typeof createHttpServer>>;

function mutableEnv(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

async function listenOnLoopback(app: App): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo | null;
  assert.ok(address, "Fastify server should expose a bound address");
  return `http://127.0.0.1:${address.port}`;
}

async function startSurface(surface: HttpSurface): Promise<{ app: App; baseUrl: string }> {
  const app = await createHttpServer({ surface });
  const baseUrl = await listenOnLoopback(app);
  return { app, baseUrl };
}

async function fetchJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, baseUrl));
  return { status: response.status, body: await response.json() };
}

function dataOf(body: unknown): Record<string, unknown> {
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  const data = (body as { data?: unknown }).data;
  assert.equal(typeof data, "object");
  assert.notEqual(data, null);
  return data as Record<string, unknown>;
}

async function closeAll(apps: App[]): Promise<void> {
  for (const app of apps.reverse()) {
    await app.close().catch(() => undefined);
  }
  await closePool();
}

async function main(): Promise<void> {
  const original = {
    SPX_ROLE: env.SPX_ROLE,
    SPX_NODE_ID: env.SPX_NODE_ID,
    LINE_SERVICE_URL: env.LINE_SERVICE_URL,
    OCR_SERVICE_URL: env.OCR_SERVICE_URL,
    LINE_SERVICE_REQUEST_TIMEOUT_MS: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
    OCR_SERVICE_REQUEST_TIMEOUT_MS: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
    NOTIFIER_SHARED_SECRET: env.NOTIFIER_SHARED_SECRET,
  };
  const apps: App[] = [];

  try {
    Object.assign(mutableEnv(), {
      SPX_ROLE: "api",
      SPX_NODE_ID: "local-web-api",
      LINE_SERVICE_URL: "",
      OCR_SERVICE_URL: "",
      LINE_SERVICE_REQUEST_TIMEOUT_MS: 100,
      OCR_SERVICE_REQUEST_TIMEOUT_MS: 100,
      NOTIFIER_SHARED_SECRET: "local-fault-drill-secret",
    });

    const ocrService = await startSurface("ocr-service");
    apps.push(ocrService.app);
    const lineService = await startSurface("line-service");
    apps.push(lineService.app);

    Object.assign(mutableEnv(), {
      LINE_SERVICE_URL: lineService.baseUrl,
      OCR_SERVICE_URL: ocrService.baseUrl,
    });

    const notificationService = await startSurface("notification-service");
    apps.push(notificationService.app);
    const webApi = await startSurface("web-api");
    apps.push(webApi.app);

    const webReady = await fetchJson(webApi.baseUrl, "/ready");
    assert.equal(webReady.status, 200);
    assert.equal(dataOf(webReady.body).ready, true);

    const notificationReady = await fetchJson(notificationService.baseUrl, "/ready");
    assert.equal(notificationReady.status, 200);
    assert.equal(dataOf(notificationReady.body).ready, true);

    await lineService.app.close();
    apps.splice(apps.indexOf(lineService.app), 1);

    const webReadyWithLineDown = await fetchJson(webApi.baseUrl, "/ready");
    assert.equal(webReadyWithLineDown.status, 200);
    const webDataWithLineDown = dataOf(webReadyWithLineDown.body);
    assert.equal(webDataWithLineDown.ready, true);
    assert.equal(
      (webDataWithLineDown.dependencies as Array<{ service: string; state: string }>).some(
        (item) => item.service === "line-service" && item.state === "down",
      ),
      true,
    );

    const notificationReadyWithLineDown = await fetchJson(notificationService.baseUrl, "/ready");
    assert.equal(notificationReadyWithLineDown.status, 503);
    assert.equal(dataOf(notificationReadyWithLineDown.body).ready, false);

    const lineServiceRecovered = await startSurface("line-service");
    apps.push(lineServiceRecovered.app);
    mutableEnv().LINE_SERVICE_URL = lineServiceRecovered.baseUrl;

    const notificationReadyRecovered = await fetchJson(notificationService.baseUrl, "/ready");
    assert.equal(notificationReadyRecovered.status, 200);
    assert.equal(dataOf(notificationReadyRecovered.body).ready, true);

    await ocrService.app.close();
    apps.splice(apps.indexOf(ocrService.app), 1);

    const webReadyWithOcrDown = await fetchJson(webApi.baseUrl, "/ready");
    assert.equal(webReadyWithOcrDown.status, 200);
    const webDataWithOcrDown = dataOf(webReadyWithOcrDown.body);
    assert.equal(webDataWithOcrDown.ready, true);
    assert.equal(
      (webDataWithOcrDown.dependencies as Array<{ service: string; state: string }>).some(
        (item) => item.service === "ocr-service" && item.state === "down",
      ),
      true,
    );

    const ocrServiceRecovered = await startSurface("ocr-service");
    apps.push(ocrServiceRecovered.app);
    mutableEnv().OCR_SERVICE_URL = ocrServiceRecovered.baseUrl;

    const webReadyRecovered = await fetchJson(webApi.baseUrl, "/ready");
    assert.equal(webReadyRecovered.status, 200);
    assert.equal(dataOf(webReadyRecovered.body).ready, true);
  } finally {
    Object.assign(mutableEnv(), original);
    await closeAll(apps);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
