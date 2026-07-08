import assert from "node:assert/strict";
import {
  LINE_INTERNAL_GROUPS_PATH,
  LINE_INTERNAL_LOGIN_PATH,
  LINE_INTERNAL_LOGOUT_PATH,
  LINE_INTERNAL_PROFILE_PATH,
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STATUS_PATH,
  LINE_INTERNAL_STORAGE_PATH,
} from "../src/services/line-service-contract.js";
import { createHttpServer } from "../src/services/http-server.js";

const lineInternalPaths = [
  LINE_INTERNAL_SEND_PATH,
  LINE_INTERNAL_STATUS_PATH,
  LINE_INTERNAL_LOGIN_PATH,
  LINE_INTERNAL_GROUPS_PATH,
  LINE_INTERNAL_PROFILE_PATH,
  LINE_INTERNAL_STORAGE_PATH,
  LINE_INTERNAL_LOGOUT_PATH,
];

async function withServer<T>(
  surface: Parameters<typeof createHttpServer>[0]["surface"],
  fn: (app: Awaited<ReturnType<typeof createHttpServer>>) => Promise<T>,
): Promise<T> {
  const app = await createHttpServer({ surface });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  await withServer("line-service", async (app) => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(settings.statusCode, 404);

    const internalNotification = await app.inject({
      method: "POST",
      url: "/internal/notification-events",
      payload: {},
    });
    assert.equal(internalNotification.statusCode, 404);

    for (const url of lineInternalPaths) {
      const internalLine = await app.inject({
        method: "POST",
        url,
        payload: {},
      });
      assert.equal(
        internalLine.statusCode,
        401,
        `${url} should be registered only on line-service`,
      );
    }

    const internalOcr = await app.inject({
      method: "POST",
      url: "/internal/ocr/line-image",
      payload: {},
    });
    assert.equal(internalOcr.statusCode, 404);
  });

  await withServer("notification-service", async (app) => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(settings.statusCode, 404);

    const internalNotification = await app.inject({
      method: "POST",
      url: "/internal/notification-events",
      payload: {},
    });
    assert.equal(internalNotification.statusCode, 401);

    const internalOcr = await app.inject({
      method: "POST",
      url: "/internal/ocr/line-image",
      payload: {},
    });
    assert.equal(internalOcr.statusCode, 404);

    for (const url of lineInternalPaths) {
      const internalLine = await app.inject({
        method: "POST",
        url,
        payload: {},
      });
      assert.equal(
        internalLine.statusCode,
        404,
        `${url} should not be registered on notification-service`,
      );
    }
  });

  await withServer("ocr-service", async (app) => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(settings.statusCode, 404);

    const internalNotification = await app.inject({
      method: "POST",
      url: "/internal/notification-events",
      payload: {},
    });
    assert.equal(internalNotification.statusCode, 404);

    for (const url of lineInternalPaths) {
      const internalLine = await app.inject({
        method: "POST",
        url,
        payload: {},
      });
      assert.equal(internalLine.statusCode, 404, `${url} should not be registered on ocr-service`);
    }

    const internalOcr = await app.inject({
      method: "POST",
      url: "/internal/ocr/line-image",
      payload: {},
    });
    assert.equal(internalOcr.statusCode, 401);
  });

  await withServer("web-api", async (app) => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(settings.statusCode, 401);

    for (const url of lineInternalPaths) {
      const internalLine = await app.inject({
        method: "POST",
        url,
        payload: {},
      });
      assert.equal(internalLine.statusCode, 404, `${url} should not be registered on web-api`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
