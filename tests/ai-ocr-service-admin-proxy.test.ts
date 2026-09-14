process.env.DB_MODE = "memory";
process.env.OCR_SERVICE_URL = "https://ocr.internal.example:3004";
process.env.OCR_SERVICE_ADMIN_SECRET = "ocr-proxy-admin-secret";
process.env.OCR_SERVICE_REQUEST_TIMEOUT_MS = "1500";
process.env.SPX_NODE_ID = "web-api-proxy-01";

import assert from "node:assert/strict";
import Fastify from "fastify";
import { verifyInternalSignature } from "../src/services/internal-auth.js";
import { OCR_INTERNAL_ADMIN_STATUS_PATH } from "../src/services/ocr-service-admin-contract.js";

async function main(): Promise<void> {
  const { aiController } = await import("../src/controllers/ai-controller.js");
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async (input, init) => {
    providerRequests += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.pathname, OCR_INTERNAL_ADMIN_STATUS_PATH);
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    const timestamp = headers.get("x-spx-timestamp") ?? "";
    const requestId = headers.get("x-spx-request-id") ?? "";
    assert.match(requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(verifyInternalSignature({
      body,
      timestamp,
      nodeId: "web-api-proxy-01",
      path: OCR_INTERNAL_ADMIN_STATUS_PATH,
      secret: "ocr-proxy-admin-secret",
      signature: headers.get("x-spx-signature") ?? "",
      requestId,
      now: new Date(timestamp),
    }), { ok: true });
    assert.deepEqual(JSON.parse(body), { kind: "status" });
    return new Response(JSON.stringify({
      status: "success",
      data: { authenticated: true, provider: "codex-device", expiresAt: null },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.user = { id: 7, username: "proxy-admin", role: "admin", teamId: null };
  });
  try {
    await app.register(aiController, {
      authRateLimiter: {
        consume: () => ({
          allowed: true,
          limitingScope: null,
          resetAt: Date.now() + 60_000,
          retryAfterMs: 0,
          shouldAudit: false,
        }),
      },
      auditWriter: async () => undefined,
    });
    const response = await app.inject({ method: "GET", url: "/codex-auth/status" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body).data, {
      authenticated: true,
      provider: "codex-device",
      expiresAt: null,
    });
    assert.equal(providerRequests, 1);
    assert.doesNotMatch(response.body, /ocr-proxy-admin-secret|authPath|\.codex/);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
