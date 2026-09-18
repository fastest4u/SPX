import assert from "node:assert/strict";
import { ApiClient, type ApiClientCredentials } from "../src/services/api-client.js";

async function main(): Promise<void> {
  const accounts: ApiClientCredentials[] = [
    { spxCookie: "cookie-1", spxDeviceId: "device-1", accountId: 101, accountName: "Acc1" },
    { spxCookie: "cookie-2", spxDeviceId: "device-2", accountId: 102, accountName: "Acc2" },
  ];
  let idx = 0;
  const rateLimitedAccounts: Array<{ accountId?: number; delayMs: number }> = [];
  const sessionExpiredAccounts: Array<number | undefined> = [];

  const client = new ApiClient({
    credentialsProvider: () => {
      const cred = accounts[idx % accounts.length];
      idx++;
      return cred;
    },
    onRateLimit: (accountId, delayMs) => {
      rateLimitedAccounts.push({ accountId, delayMs });
    },
    onSessionExpired: (accountId) => {
      sessionExpiredAccounts.push(accountId);
    },
  });

  // Verify headers rotation
  // First access gets Acc1
  const h1 = (client as unknown as { headers: Record<string, string> }).headers;
  assert.equal(h1.cookie, "cookie-1");
  assert.equal(client.currentCredentials?.accountId, 101);

  // Second access gets Acc2
  const h2 = (client as unknown as { headers: Record<string, string> }).headers;
  assert.equal(h2.cookie, "cookie-2");
  assert.equal(client.currentCredentials?.accountId, 102);

  // Third access gets Acc1
  const h3 = (client as unknown as { headers: Record<string, string> }).headers;
  assert.equal(h3.cookie, "cookie-1");
  assert.equal(client.currentCredentials?.accountId, 101);

  // Test onRateLimit hook trigger
  const mock429Response = new Response("Too Many Requests", {
    status: 429,
    headers: { "retry-after": "5" },
  });
  (client as unknown as { deferAfterRateLimit: (res: Response) => void }).deferAfterRateLimit(mock429Response);
  assert.equal(rateLimitedAccounts.length, 1);
  assert.equal(rateLimitedAccounts[0].accountId, 101);
  assert.equal(rateLimitedAccounts[0].delayMs, 5000);

  // Test onSessionExpired hook trigger in accept
  // First, set headers to Acc2
  assert.ok((client as unknown as { headers: Record<string, string> }).headers);
  assert.equal(client.currentCredentials?.accountId, 102);

  // Inspect read response with session expired retcode (e.g. 401)
  const mockSessionExpiredResponse = new Response(JSON.stringify({ retcode: 401, message: "unauthorized" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await (client as unknown as { inspectReadResponse: (res: Response) => Promise<void> }).inspectReadResponse(mockSessionExpiredResponse);
  assert.equal(sessionExpiredAccounts.length, 1);
  assert.equal(sessionExpiredAccounts[0], 102);

  console.log("api-client-multi-account: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
