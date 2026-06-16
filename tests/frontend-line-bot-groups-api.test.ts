import assert from "node:assert/strict";
import {
  formatLineChatOptionLabel,
  getSelectableLineGroupChats,
  isRedactedSecretPreview,
  isSelectableLineGroupId,
  sortLineChatsForTeamSelect,
} from "../src/frontend/lib/line-groups.js";
import type { LineBotGroupList } from "../src/frontend/types/index.js";

const responses = [
  {
    url: "/api/line-bot/groups",
    status: 200,
    body: {
      status: "success",
      data: {
        chats: [
          { chatMid: "c-team-alpha", chatName: "Team Alpha Dispatch" },
          { chatMid: "u-owner", chatName: "Owner" },
        ],
      },
    },
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
  const { lineBotApi } = await import("../src/frontend/lib/api.js");
  const groups: LineBotGroupList = await lineBotApi.getGroups();

  assert.deepEqual(groups.chats, [
    { chatMid: "c-team-alpha", chatName: "Team Alpha Dispatch" },
    { chatMid: "u-owner", chatName: "Owner" },
  ]);
  assert.equal(responses.length, 0);

  const sorted = sortLineChatsForTeamSelect([
    { chatMid: "u-owner", chatName: "Owner" },
    { chatMid: "c-team-beta", chatName: "Beta Dispatch" },
    { chatMid: "c-team-alpha", chatName: "Alpha Dispatch" },
  ]);
  assert.deepEqual(sorted.map((chat) => chat.chatMid), ["c-team-alpha", "c-team-beta", "u-owner"]);
  assert.deepEqual(getSelectableLineGroupChats(sorted).map((chat) => chat.chatMid), ["c-team-alpha", "c-team-beta"]);
  assert.equal(formatLineChatOptionLabel({ chatMid: "c-team-alpha", chatName: "  " }), "ไม่ทราบชื่อ (am-alpha)");
  assert.equal(isRedactedSecretPreview("********7d73"), true);
  assert.equal(isRedactedSecretPreview("c-team-alpha"), false);
  assert.equal(isSelectableLineGroupId("c-team-alpha", sorted), true);
  assert.equal(isSelectableLineGroupId("u-owner", sorted), false);
  assert.equal(isSelectableLineGroupId("********7d73", sorted), false);
  assert.equal(isSelectableLineGroupId("c-missing", sorted), false);

  console.log("frontend-line-bot-groups-api: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
