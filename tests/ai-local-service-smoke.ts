import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { aiController } from "../src/controllers/ai-controller.js";

const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8jV9wAAAABJRU5ErkJggg==",
  "base64",
);

const app = Fastify({ logger: false });

function mimeTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function main(): Promise<void> {
  try {
    await app.register(fastifyMultipart);
    await app.register(aiController, { prefix: "/api/ai" });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const imagePath = process.argv[2];
    const image = imagePath ? await readFile(imagePath) : samplePng;
    const filename = imagePath ? basename(imagePath) : "sample.png";
    const mimeType = imagePath ? mimeTypeForPath(imagePath) : "image/png";
    const form = new FormData();
    form.set("file", new File([image], filename, { type: mimeType }));
    const prompt = process.argv[3] ?? (imagePath ? undefined : "Reply exactly OK if you received the image.");
    if (prompt) {
      form.set("prompt", prompt);
    }

    const response = await fetch(`${address}/api/ai/read-image`, {
      method: "POST",
      body: form,
    });
    const body = await response.json() as { status?: string; data?: { text?: string }; message?: string };

    assert.equal(response.status, 200, body.message ?? JSON.stringify(body));
    assert.equal(body.status, "success");
    if (!imagePath) {
      assert.match(body.data?.text ?? "", /OK/i);
    }

    console.log(JSON.stringify({ ok: true, status: response.status, text: body.data?.text }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
