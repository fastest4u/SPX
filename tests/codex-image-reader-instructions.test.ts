import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fakeJwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
}

async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) return;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.CODEX_IMAGE_PROVIDER;
  const originalSecretsKey = process.env.SECRETS_KEY;
  const tempDir = await mkdtemp(join(tmpdir(), "spx-codex-image-test-"));

  try {
    process.chdir(tempDir);
    process.env.CODEX_IMAGE_PROVIDER = "codex-device";
    process.env.SECRETS_KEY = `codex-test-secret-${randomUUID()}`;
    await mkdir("data", { recursive: true });
    await writeFile("image.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const expiresAt = Date.now() + 60 * 60_000;
    const accessToken = fakeJwt({
      exp: Math.floor(expiresAt / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
    });
    const refreshToken = `refresh_${randomUUID()}`;
    await writeFile("data/codex-device-auth.json", JSON.stringify({
      accessToken,
      refreshToken,
      expiresAt,
      accountId: "acct_test",
      updatedAt: new Date().toISOString(),
    }));

    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      assert.match(url, /\/backend-api\/codex\/responses$/);
      assert.equal(typeof init?.body, "string");

      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      if (typeof capturedBody.instructions !== "string" || !capturedBody.instructions.trim()) {
        return new Response(JSON.stringify({ detail: "Instructions are required" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        });
      }
      if (capturedBody.store !== false) {
        return new Response(JSON.stringify({ detail: "Store must be set to false" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        });
      }
      if (capturedBody.stream !== true) {
        return new Response(JSON.stringify({ detail: "Stream must be set to true" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
        });
      }

      const response = {
        id: "resp_test",
        created_at: Math.floor(Date.now() / 1000),
        model: capturedBody.model,
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      };

      return new Response([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "o" })}`,
        `data: ${JSON.stringify({ type: "response.output_text.done", text: "ok" })}`,
        `data: ${JSON.stringify({ type: "response.completed", response })}`,
        "",
      ].join("\n"), {
        status: 200,
      });
    };

    const moduleUrl = pathToFileURL(join(originalCwd, "src/services/codex-image-reader.js")).href;
    const codexImageReader = await import(moduleUrl);
    const { readImageWithCodex } = (codexImageReader.default ?? codexImageReader) as typeof import("../src/services/codex-image-reader.js");

    const text = await readImageWithCodex({
      imagePath: "image.jpg",
      mimeType: "image/jpeg",
      prompt: "Reply ok.",
      timeoutMs: 5000,
    });

    assert.equal(text, "ok");
    assert.equal(typeof capturedBody?.instructions, "string");
    assert.ok((capturedBody.instructions as string).trim().length > 0);
    assert.equal(capturedBody.store, false);
    assert.equal(capturedBody.stream, true);

    const storedAuth = await readFile("data/codex-device-auth.json", "utf8");
    assert.equal(storedAuth.includes(accessToken), false);
    assert.equal(storedAuth.includes(refreshToken), false);
    const storedAuthJson = JSON.parse(storedAuth) as { accessToken?: string; refreshToken?: string };
    assert.equal(storedAuthJson.accessToken?.startsWith("enc:v1:"), true);
    assert.equal(storedAuthJson.refreshToken?.startsWith("enc:v1:"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) {
      delete process.env.CODEX_IMAGE_PROVIDER;
    } else {
      process.env.CODEX_IMAGE_PROVIDER = originalProvider;
    }
    if (originalSecretsKey === undefined) {
      delete process.env.SECRETS_KEY;
    } else {
      process.env.SECRETS_KEY = originalSecretsKey;
    }
    process.chdir(originalCwd);
    await removeTempDir(tempDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
