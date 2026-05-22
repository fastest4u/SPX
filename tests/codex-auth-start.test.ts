import assert from "node:assert/strict";
import Fastify from "fastify";
import { aiController } from "../src/controllers/ai-controller.js";

async function settleCurrentCallbackServer(responseBody: unknown): Promise<void> {
  if (!responseBody || typeof responseBody !== "object" || !("data" in responseBody)) {
    return;
  }

  const data = responseBody.data;
  if (!data || typeof data !== "object" || !("state" in data)) {
    return;
  }

  try {
    await fetch("http://localhost:1455/auth/callback?code=unused&state=wrong");
    await new Promise(resolve => setTimeout(resolve, 2500));
  } catch {
    // No callback server was started.
  }
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });

  try {
    await app.register(aiController, { prefix: "/api/ai" });

    const response = await app.inject({
      method: "POST",
      url: "/api/ai/codex-auth/start",
      payload: {},
    });
    const body = response.json();

    if (response.statusCode !== 400) {
      await settleCurrentCallbackServer(body);
    }

    assert.equal(response.statusCode, 400);
    assert.equal(body.status, "error");
    assert.equal(body.error_code, "CODEX_AUTH_MODE_REQUIRED");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
