import assert from "node:assert/strict";
import Fastify from "fastify";
import { lineBotController } from "../src/controllers/line-bot-controller.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  let statusCalls = 0;
  let sendCalls = 0;
  let loginCalls = 0;
  let groupsCalls = 0;
  let profileCalls = 0;
  let storageCalls = 0;
  let logoutCalls = 0;
  let logoutClearStorage: boolean | undefined;
  let localLoadCalls = 0;
  let sentTo = "";
  let sentText = "";

  await app.register(lineBotController, {
    lineService: {
      isEnabled: () => true,
      getStatus: async () => {
        statusCalls += 1;
        return {
          ok: true,
          retryable: false,
          status: {
            enabled: true,
            authenticated: false,
            qrUrl: "https://qr.example/scan",
            pincode: "123456",
            listenerActive: true,
          },
        };
      },
      sendMessage: async (request) => {
        sendCalls += 1;
        sentTo = request.targetId;
        sentText = request.text;
        return {
          ok: true,
          providerMessageId: "line-msg-remote-1",
          retryable: false,
        };
      },
      requestLogin: async () => {
        loginCalls += 1;
        return {
          ok: true,
          retryable: false,
          status: {
            enabled: true,
            authenticated: false,
            qrUrl: "https://qr.example/scan",
            pincode: "246810",
            listenerActive: true,
            message: "QR login initiated",
          },
        };
      },
      getGroups: async () => {
        groupsCalls += 1;
        return {
          ok: true,
          retryable: false,
          groups: { chats: [{ chatMid: "C123", chatName: "Dispatch" }] },
        };
      },
      getProfile: async () => {
        profileCalls += 1;
        return {
          ok: true,
          retryable: false,
          profile: { displayName: "SPX Bot", mid: "u123", statusMessage: "ready" },
        };
      },
      getStorage: async () => {
        storageCalls += 1;
        return {
          ok: true,
          retryable: false,
          storage: {
            storagePath: "data/linejs-storage.json",
            exists: true,
            sizeBytes: 128,
            hasE2EEKeys: true,
            hasAuthState: true,
          },
        };
      },
      logout: async (request) => {
        logoutCalls += 1;
        logoutClearStorage = request.clearStorage;
        return {
          ok: true,
          retryable: false,
          logout: { loggedOut: true, clearStorage: Boolean(request.clearStorage) },
        };
      },
    },
    loadLocalLineBot: async () => {
      localLoadCalls += 1;
      throw new Error("local LINEJS must not load in remote line-service mode");
    },
  });

  const response = await app.inject({ method: "GET", url: "/status" });
  assert.equal(response.statusCode, 200);
  assert.equal(statusCalls, 1);

  const body = response.json() as {
    status: "success";
    data: {
      enabled: boolean;
      authenticated: boolean;
      qrUrl?: string;
      pincode?: string;
      listenerActive?: boolean;
      message: string;
    };
  };
  assert.equal(body.status, "success");
  assert.deepEqual(body.data, {
    enabled: true,
    authenticated: false,
    qrUrl: "https://qr.example/scan",
    pincode: "123456",
    listenerActive: true,
    message: "LINE Bot is not yet authenticated",
  });

  const sendResponse = await app.inject({
    method: "POST",
    url: "/send",
    payload: {
      to: "C123456789",
      text: "hello from web api",
    },
  });
  assert.equal(sendResponse.statusCode, 200);
  assert.equal(sendCalls, 1);
  assert.equal(sentTo, "C123456789");
  assert.equal(sentText, "hello from web api");
  assert.deepEqual(sendResponse.json(), {
    status: "success",
    message: "Message sent successfully",
    data: { sent: true },
  });
  assert.equal(localLoadCalls, 0);

  const loginResponse = await app.inject({ method: "POST", url: "/login" });
  assert.equal(loginResponse.statusCode, 200);
  assert.equal(loginCalls, 1);
  assert.deepEqual(loginResponse.json(), {
    status: "success",
    message: "QR login initiated",
    data: {
      enabled: true,
      authenticated: false,
      qrUrl: "https://qr.example/scan",
      pincode: "246810",
      listenerActive: true,
      message: "QR login initiated",
    },
  });

  const groupsResponse = await app.inject({ method: "GET", url: "/groups" });
  assert.equal(groupsResponse.statusCode, 200);
  assert.equal(groupsCalls, 1);
  assert.deepEqual(groupsResponse.json(), {
    status: "success",
    data: { chats: [{ chatMid: "C123", chatName: "Dispatch" }] },
  });

  const profileResponse = await app.inject({ method: "GET", url: "/profile" });
  assert.equal(profileResponse.statusCode, 200);
  assert.equal(profileCalls, 1);
  assert.deepEqual(profileResponse.json(), {
    status: "success",
    data: { displayName: "SPX Bot", mid: "u123", statusMessage: "ready" },
  });

  const storageResponse = await app.inject({ method: "GET", url: "/storage" });
  assert.equal(storageResponse.statusCode, 200);
  assert.equal(storageCalls, 1);
  assert.deepEqual(storageResponse.json(), {
    status: "success",
    data: {
      storagePath: "data/linejs-storage.json",
      exists: true,
      sizeBytes: 128,
      hasE2EEKeys: true,
      hasAuthState: true,
    },
  });

  const logoutResponse = await app.inject({
    method: "POST",
    url: "/logout",
    payload: { clearStorage: true },
  });
  assert.equal(logoutResponse.statusCode, 200);
  assert.equal(logoutCalls, 1);
  assert.equal(logoutClearStorage, true);
  assert.deepEqual(logoutResponse.json(), {
    status: "success",
    message: "LINE Bot logged out",
    data: { loggedOut: true, clearStorage: true },
  });
  assert.equal(localLoadCalls, 0);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
