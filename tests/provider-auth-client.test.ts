import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ProviderAuthError,
  checkProviderSession,
  loginProvider,
} from "../src/services/provider-auth/client.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
};

const ACCOUNTS = "https://accounts.myagencyservice.in.th";
const LOGISTICS = "https://logistics.myagencyservice.in.th";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function successfulProviderFetch(
  requests: RecordedRequest[],
  identity: string | number = 19,
  sessionCookie = "fixture-session",
  identitySetCookie?: string,
  identityStatus = 200,
): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    requests.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : "",
    });

    if (url.startsWith(`${ACCOUNTS}/authenticate/login`)) {
      return new Response("login", {
        headers: { "set-cookie": "accounts_only=private; Path=/; Secure; HttpOnly" },
      });
    }
    if (url.endsWith("/api/v4/account/business/login_status")) {
      return json({ error: 48401107 });
    }
    if (url.endsWith("/api/v4/account/business/login")) {
      return json(
        { error: 0, data: { nonce: "fixture-nonce" } },
        { headers: { "set-cookie": "SPC_CLIENTID=fixture-client; Path=/; Secure; HttpOnly" } },
      );
    }
    if (url.startsWith(`${LOGISTICS}/auth/callback`)) {
      return new Response(null, {
        headers: {
          "set-cookie": `spx_uk=${sessionCookie}; Path=/; Secure; HttpOnly; Max-Age=3600`,
        },
      });
    }
    if (url.endsWith("/api/basicserver/agency/account/current_user/basic_info")) {
      return json(
        { retcode: 0, data: { user_id: identity, email: "team@example.test" } },
        { status: identityStatus, headers: identitySetCookie ? { "set-cookie": identitySetCookie } : {} },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

function cancellableResponse(
  status: number,
  headers: HeadersInit = {},
): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { wasCancelled = true; },
  });
  return {
    response: new Response(body, { status, headers }),
    cancelled: () => wasCancelled,
  };
}

async function expectProviderError(
  operation: () => Promise<unknown>,
  code: ProviderAuthError["code"],
): Promise<ProviderAuthError> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof ProviderAuthError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("fixture-password"), false);
    return error;
  }
  assert.fail(`Expected ProviderAuthError(${code})`);
}

async function main(): Promise<void> {
const requests: RecordedRequest[] = [];
const result = await loginProvider(
  { email: "team@example.test", password: "fixture-password" },
  { fetch: successfulProviderFetch(requests) },
);

assert.match(result.cookie, /spx_uk=fixture-session/);
assert.match(result.cookie, /spx-admin-device-id=[a-f0-9]{32}/);
assert.equal(result.cookie.includes("accounts_only"), false, "Accounts-only cookies must not leak to Logistics");
assert.equal(result.cookie.includes("csrftoken"), false, "Accounts CSRF cookie must remain host scoped");
assert.equal(result.deviceId.length, 32);
assert.equal(result.expiresAt === null, false);
assert.equal(requests.length, 5);
assert.equal(requests.filter((request) => request.url.endsWith("/business/login")).length, 1);
assert.equal(requests.every((request) => !request.url.includes("fixture-password")), true);

const loginRequest = requests.find((request) => request.url.endsWith("/business/login"));
assert.ok(loginRequest);
const loginBody = JSON.parse(loginRequest.body) as Record<string, unknown>;
const expectedPassword = createHash("sha256")
  .update(createHash("md5").update("fixture-password", "utf8").digest("hex"), "utf8")
  .digest("hex");
assert.deepEqual(loginBody, {
  email: "team@example.test",
  password: expectedPassword,
  captcha_signature: "",
  security_device_fingerprint: "",
});
assert.equal(loginRequest.headers.get("x-app-type"), "19");
assert.match(loginRequest.headers.get("x-csrftoken") ?? "", /^[a-f0-9]{32}$/);
assert.match(loginRequest.headers.get("cookie") ?? "", /csrftoken=/);

const verifyRequest = requests.at(-1);
assert.ok(verifyRequest);
assert.equal(verifyRequest.headers.get("device-id"), result.deviceId);
assert.match(verifyRequest.headers.get("cookie") ?? "", /spx-admin-device-id=/);

const reused = await loginProvider(
  { email: "team@example.test", password: "fixture-password" },
  { deviceId: "stable-device_01", fetch: successfulProviderFetch([]) },
);
assert.equal(reused.deviceId, "stable-device_01");

const loginFailures = [
  [48401004, "invalid_credentials"],
  [48401107, "invalid_credentials"],
  [48401128, "invalid_credentials"],
  [48401108, "challenge_required"],
  [48401109, "challenge_required"],
  [48401112, "challenge_required"],
  [48401005, "challenge_required"],
  [48401114, "challenge_required"],
  [48401142, "challenge_required"],
  [48401139, "rate_limited"],
  [48401140, "rate_limited"],
  [48401141, "rate_limited"],
  [10002, "invalid_input"],
  [987654321, "invalid_response"],
] as const;

for (const [providerCode, expectedCode] of loginFailures) {
  let loginCalls = 0;
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(`${ACCOUNTS}/authenticate/login`)) return new Response("login");
    if (url.endsWith("/business/login_status")) return json({ error: 48401107 });
    if (url.endsWith("/business/login")) {
      loginCalls += 1;
      return json({ error: providerCode, message: "unsafe provider detail" });
    }
    throw new Error(`Unexpected ${init.method ?? "GET"} ${url}`);
  };
  const error = await expectProviderError(
    () => loginProvider({ email: "team@example.test", password: "fixture-password" }, { fetch: fakeFetch }),
    expectedCode,
  );
  assert.equal(loginCalls, 1, `Provider code ${providerCode} must not retry password submission`);
  assert.equal(error.message.includes("unsafe provider detail"), false);
}

const redirectStream = cancellableResponse(302, { location: "https://example.test/steal" });
await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    {
      fetch: async (input) => String(input).includes("/authenticate/login")
        ? redirectStream.response
        : new Response(),
    },
  ),
  "invalid_response",
);
assert.equal(redirectStream.cancelled(), true, "discarded redirect bodies must be cancelled");

const oversizedStream = cancellableResponse(200, { "content-length": "1100000" });
await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    { fetch: successfulProviderFetch([], 19, "x".repeat(2_900)) },
  ),
  "invalid_response",
);

await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    {
      deviceId: "unsafe; injected=cookie",
      fetch: async () => { throw new Error("must not request"); },
    },
  ),
  "invalid_input",
);

await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    { fetch: async () => oversizedStream.response },
  ),
  "invalid_response",
);
assert.equal(oversizedStream.cancelled(), true, "declared oversized bodies must be cancelled");

const wrongIdentityFetch = successfulProviderFetch([]);
await expectProviderError(
  () => loginProvider(
    { email: "other@example.test", password: "fixture-password" },
    { fetch: wrongIdentityFetch },
  ),
  "invalid_credentials",
);

await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    { fetch: successfulProviderFetch([], 0) },
  ),
  "invalid_response",
);

const rotated = await loginProvider(
  { email: "team@example.test", password: "fixture-password" },
  {
    fetch: successfulProviderFetch(
      [],
      19,
      "superseded-session",
      "spx_uk=rotated-session; Path=/; Secure; HttpOnly; Max-Age=7200",
    ),
  },
);
assert.match(rotated.cookie, /spx_uk=rotated-session/);
assert.equal(rotated.cookie.includes("superseded-session"), false);

// The final identity response must not turn a verified request into an unusable pair.
for (const identityCookie of [
  "spx_uk=; Path=/; Secure",
  "spx-admin-device-id=unverified-device; Path=/; Secure",
]) {
  await expectProviderError(
    () => loginProvider(
      { email: "team@example.test", password: "fixture-password" },
      { fetch: successfulProviderFetch([], 19, "fixture-session", identityCookie) },
    ),
    "invalid_response",
  );
}

await expectProviderError(
  () => loginProvider(
    { email: "team@example.test", password: "fixture-password" },
    { fetch: successfulProviderFetch([], 19, "fixture-session", undefined, 201) },
  ),
  "invalid_response",
);

const session = {
  cookie: "spx_uk=fixture-session; spx-admin-device-id=0123456789abcdef0123456789abcdef",
  deviceId: "0123456789abcdef0123456789abcdef",
  expiresAt: null,
};
assert.deepEqual(
  await checkProviderSession(session, {
    fetch: async () => json({ retcode: 0, data: { id: 19 } }, { status: 201 }),
  }),
  { status: "unavailable", errorCode: "invalid_response", retryAfterMs: null },
  "identity verification requires exact HTTP 200 on reactive checks as well as login",
);
assert.deepEqual(
  await checkProviderSession(session, {
    fetch: async () => json({ retcode: 0, data: { id: 19, email: "team@example.test" } }),
  }),
  { status: "valid" },
);
const unauthorizedStream = cancellableResponse(401);
assert.deepEqual(
  await checkProviderSession(session, { fetch: async () => unauthorizedStream.response }),
  { status: "expired", errorCode: "session_expired" },
);
assert.equal(unauthorizedStream.cancelled(), true, "early identity status bodies must be cancelled");
assert.deepEqual(
  await checkProviderSession(session, { fetch: async () => new Response("gateway denied", { status: 403 }) }),
  { status: "unavailable", errorCode: "provider_unavailable", retryAfterMs: null },
);
assert.deepEqual(
  await checkProviderSession(session, {
    fetch: async () => json({}, { status: 429, headers: { "retry-after": "9999" } }),
  }),
  { status: "unavailable", errorCode: "rate_limited", retryAfterMs: 300_000 },
);
assert.deepEqual(
  await checkProviderSession(session, { fetch: async () => json({ retcode: 10002, data: null }) }),
  { status: "unavailable", errorCode: "invalid_input", retryAfterMs: null },
);
assert.deepEqual(
  await checkProviderSession(session, { fetch: async () => new Response("not-json") }),
  { status: "unavailable", errorCode: "invalid_response", retryAfterMs: null },
);
assert.deepEqual(
  await checkProviderSession(session, { fetch: async () => { throw new Error("unsafe transport detail"); } }),
  { status: "unavailable", errorCode: "provider_unavailable", retryAfterMs: null },
);

let completedSignal: AbortSignal | undefined;
assert.deepEqual(
  await checkProviderSession(session, {
    fetch: async (_input, init) => {
      completedSignal = init?.signal ?? undefined;
      return json({ retcode: 0, data: { user_id: 19 } });
    },
  }),
  { status: "valid" },
);
assert.equal(completedSignal?.aborted, true, "the attempt deadline signal must be aborted during cleanup");

console.log("provider-auth-client: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
