process.env.DB_MODE = "memory";
process.env.SECRETS_KEY = "ocr-admin-boundary-secrets-key";
process.env.JWT_SECRET = "ocr-admin-boundary-jwt-secret-value";
process.env.COOKIE_SECRET = "ocr-admin-boundary-cookie-secret-value";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function parseCookie(setCookie: string | null): string {
  assert.ok(setCookie, "login should set an auth cookie");
  return setCookie.split(";")[0] ?? "";
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return port;
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, await response.text());
  return parseCookie(response.headers.get("set-cookie"));
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const isolatedCwd = await mkdtemp(join(tmpdir(), "spx-ocr-admin-boundary-"));
  let stopHttpServer: (() => Promise<void>) | undefined;
  let serverStarted = false;

  try {
    await mkdir(join(isolatedCwd, "dist", "public"), { recursive: true });
    await mkdir(join(isolatedCwd, "data", "line-images"), { recursive: true });
    process.chdir(isolatedCwd);

    const { resetMemoryDb } = await import("../src/db/client-memory.js");
    const { createTeam } = await import("../src/repositories/team-repository.js");
    const { createUser } = await import("../src/repositories/user-repository.js");
    const httpServer = await import("../src/services/http-server.js");
    stopHttpServer = httpServer.stopHttpServer;

    resetMemoryDb();
    const team = await createTeam({ name: "OCR Boundary", enabled: true });
    await createUser("ocr-user", "password-123456", "user", team.id);
    await createUser("ocr-admin", "password-123456", "admin", null);

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    await httpServer.startHttpServer(port);
    serverStarted = true;

    assert.equal((await fetch(`${baseUrl}/api/ai/codex-auth/status`)).status, 401);

    const userCookie = await login(baseUrl, "ocr-user", "password-123456");
    const userHeaders = { Cookie: userCookie };
    assert.equal(
      (await fetch(`${baseUrl}/api/ai/codex-auth/status`, { headers: userHeaders })).status,
      403,
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/line-image-extractions`, { headers: userHeaders })).status,
      403,
    );
    assert.equal(
      (await fetch(`${baseUrl}/line-images/example.png`, { headers: userHeaders })).status,
      403,
    );

    const adminCookie = await login(baseUrl, "ocr-admin", "password-123456");
    const adminStatus = await fetch(`${baseUrl}/api/ai/codex-auth/status`, {
      headers: { Cookie: adminCookie },
    });
    const adminStatusBody = await adminStatus.json();
    const serializedStatus = JSON.stringify(adminStatusBody);
    assert.equal(adminStatus.status, 200, serializedStatus);
    assert.doesNotMatch(serializedStatus, /authPath|[A-Za-z]:\\|\/home\/|\/root\/|\.codex/i);
  } finally {
    if (serverStarted && stopHttpServer) await stopHttpServer();
    process.chdir(originalCwd);
    await rm(isolatedCwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
