import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { sendLineTargetMessage } from "../src/services/notifier.js";
import { LogLevel, setLogLevel } from "../src/utils/logger.js";

setLogLevel(LogLevel.ERROR);

type MutableEnv = {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINEJS_TEST_ENABLED: boolean;
};

async function main(): Promise<void> {
  const mutableEnv = env as unknown as MutableEnv;
  const originalToken = mutableEnv.LINE_CHANNEL_ACCESS_TOKEN;
  const originalLineJsEnabled = mutableEnv.LINEJS_TEST_ENABLED;
  const originalFetch = globalThis.fetch;

  let pushedText = "";
  const expectedText = [
    "✅ SPX Auto-Accept สำเร็จ 3 รายการ",
    "🛣️ เส้นทาง ที่ 1 id=40298007 SOCN ➜ HKYAO-A - คันนายาว (29/06/2569 06:30)",
  ].join("\n");

  mutableEnv.LINE_CHANNEL_ACCESS_TOKEN = "line-oa-token";
  mutableEnv.LINEJS_TEST_ENABLED = false;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ text?: string }>;
    };
    pushedText = body.messages?.[0]?.text ?? "";
    return new Response("{}", { status: 200 });
  };

  try {
    const result = await sendLineTargetMessage("C-target", expectedText);

    assert.deepEqual(result, { ok: true });
    assert.equal(pushedText, expectedText);
  } finally {
    mutableEnv.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    mutableEnv.LINEJS_TEST_ENABLED = originalLineJsEnabled;
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
