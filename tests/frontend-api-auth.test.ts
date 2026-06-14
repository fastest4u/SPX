import assert from "node:assert/strict";

type TestWindow = {
  location: {
    origin: string;
    replace(url: string): void;
  };
};

const redirects: string[] = [];
(globalThis as typeof globalThis & { window: TestWindow }).window = {
  location: {
    origin: "http://localhost",
    replace(url: string) {
      redirects.push(url);
    },
  },
};

type MockResponse = {
  url: string;
  status: number;
  body: unknown;
};

const responses: MockResponse[] = [
  {
    url: "/metrics",
    status: 401,
    body: { status: "error", error_code: "UNAUTHORIZED", message: "expired" },
  },
  {
    url: "/api/refresh",
    status: 200,
    body: { status: "success", data: null },
  },
  {
    url: "/metrics",
    status: 200,
    body: { status: "success", data: { uptime: 123 } },
  },
];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const expected = responses.shift();
  assert.ok(expected, `unexpected fetch call to ${url}`);
  assert.equal(url, expected.url);
  return new Response(JSON.stringify(expected.body), {
    status: expected.status,
    headers: { "Content-Type": "application/json" },
  });
}) satisfies typeof fetch;

async function main(): Promise<void> {
  const { metricsApi } = await import("../src/frontend/lib/api.js");
  const snapshot = await metricsApi.snapshot();

  assert.deepEqual(snapshot, { uptime: 123 });
  assert.deepEqual(redirects, []);
  assert.equal(responses.length, 0);

  console.log("frontend-api-auth: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
