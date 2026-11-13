import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseClient } from "@evex/linejs/base";
import { MemoryStorage } from "@evex/linejs/storage";
import { generateKeyPair, sharedKey } from "curve25519-js";
import {
  clampCurve25519Scalar,
  installLineClientE2EEHardening,
  isClampedCurve25519Scalar,
  resolveClientSelfMid,
  syncE2EEStorageKeys,
  x25519Unclamped,
} from "../src/services/line-bot.js";

function sha256Concat(...parts: Array<Buffer | Uint8Array | string>): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? Buffer.from(part) : part);
  }
  return hash.digest();
}

function xorHalf(buf: Buffer): Buffer {
  const half = Math.floor(buf.length / 2);
  const out = Buffer.alloc(half);
  for (let i = 0; i < half; i += 1) {
    out[i] = buf[i]! ^ buf[half + i]!;
  }
  return out;
}

function int32BytesBE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

function encryptGroupKeyForMember(
  creatorPriv: Uint8Array,
  memberPub: Uint8Array,
  groupPriv: Buffer,
): Buffer {
  const secret = Buffer.from(sharedKey(creatorPriv, memberPub));
  const aesKey = sha256Concat(secret, "Key");
  const aesIv = xorHalf(sha256Concat(secret, "IV"));
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesIv);
  return Buffer.concat([cipher.update(groupPriv), cipher.final()]);
}

function decryptGroupKeyForMember(
  memberPriv: Uint8Array,
  creatorPub: Uint8Array,
  encryptedSharedKey: Buffer,
): Buffer {
  const secret = Buffer.from(sharedKey(memberPriv, creatorPub));
  const aesKey = sha256Concat(secret, "Key");
  const aesIv = xorHalf(sha256Concat(secret, "IV"));
  const decipher = createDecipheriv("aes-256-cbc", aesKey, aesIv);
  return Buffer.concat([decipher.update(encryptedSharedKey), decipher.final()]);
}

function encryptOfficialLineGroupV2Chunks(params: {
  groupPriv: Buffer;
  senderPub: Uint8Array;
  senderKeyId: number;
  groupKeyId: number;
  to: string;
  from: string;
  payload: Record<string, unknown>;
  contentType: number;
}): Buffer[] {
  // Official LINE clients multiply the full 256-bit group scalar without clearing bit 255.
  const rawSecret = x25519Unclamped(params.groupPriv, params.senderPub);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const gcmKey = sha256Concat(rawSecret, salt, "Key");
  const aad = Buffer.concat([
    Buffer.from(params.to),
    Buffer.from(params.from),
    int32BytesBE(params.senderKeyId),
    int32BytesBE(params.groupKeyId),
    int32BytesBE(2),
    int32BytesBE(params.contentType),
  ]);
  const cipher = createCipheriv("aes-256-gcm", gcmKey, nonce);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(params.payload), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return [
    salt,
    encrypted,
    nonce,
    int32BytesBE(params.senderKeyId),
    int32BytesBE(params.groupKeyId),
  ];
}

async function testCurve25519Primitives(): Promise<void> {
  const raw = Buffer.alloc(32, 0xff);
  assert.equal(isClampedCurve25519Scalar(raw), false);

  const clamped = clampCurve25519Scalar(raw);
  assert.equal(clamped.byteLength, 32);
  assert.equal(raw[0], 0xff, "clampCurve25519Scalar should not mutate input buffer");
  assert.equal(clamped[0]! & 7, 0);
  assert.equal(clamped[31]! & 128, 0);
  assert.equal(clamped[31]! & 64, 64);
  assert.equal(isClampedCurve25519Scalar(clamped), true);

  const peer = generateKeyPair(Uint8Array.from(randomBytes(32)));
  const randomClamped = clampCurve25519Scalar(randomBytes(32));
  assert.deepEqual(
    x25519Unclamped(randomClamped, peer.public),
    Buffer.from(sharedKey(Uint8Array.from(randomClamped), peer.public)),
    "clamped scalar must produce identical shared secret under clamped and unclamped X25519",
  );

  const unclampedHighBit = Buffer.from(randomClamped);
  unclampedHighBit[31]! |= 0x80;
  assert.equal(isClampedCurve25519Scalar(unclampedHighBit), false);
  assert.deepEqual(
    x25519Unclamped(clampCurve25519Scalar(unclampedHighBit), peer.public),
    Buffer.from(sharedKey(Uint8Array.from(unclampedHighBit), peer.public)),
  );
  assert.notDeepEqual(
    x25519Unclamped(unclampedHighBit, peer.public),
    Buffer.from(sharedKey(Uint8Array.from(unclampedHighBit), peer.public)),
  );

  // Invalid scalar/point byte lengths must throw RangeError
  assert.throws(() => clampCurve25519Scalar(Buffer.alloc(31)), RangeError);
  assert.throws(() => x25519Unclamped(Buffer.alloc(31), peer.public), RangeError);
  assert.throws(() => x25519Unclamped(randomClamped, Buffer.alloc(33)), RangeError);

  // RFC 7748 / SafeCurves low-order Curve25519 points (canonical & non-canonical mod 2^255-19)
  // must be rejected for BOTH clamped and unclamped scalars (even with odd cofactor bits!)
  const p = (1n << 255n) - 19n;
  const lowOrderUs = [
    0n,
    1n,
    325606250916557431795983626356110631294008115727848805560023387167927233504n,
    39382357235489614581723060781553021112529911719440698176882885853963445705823n,
    p - 1n,
    p,
    p + 1n,
  ];
  const oddUnclampedScalar = Buffer.from(unclampedHighBit);
  oddUnclampedScalar[0]! |= 1;
  for (const u of lowOrderUs) {
    const point = Buffer.alloc(32);
    let cur = u;
    for (let i = 0; i < 32; i += 1) {
      point[i] = Number(cur & 0xffn);
      cur >>= 8n;
    }
    assert.throws(
      () => x25519Unclamped(oddUnclampedScalar, point),
      /low-order|invalid/i,
      `x25519Unclamped must reject low-order u=${u.toString()}`,
    );
  }

  assert.equal(
    resolveClientSelfMid({ base: { profile: { mid: "ub4cd14af4a8aff43c42c71398654aca7" } } }),
    "ub4cd14af4a8aff43c42c71398654aca7",
  );
  assert.equal(
    resolveClientSelfMid({
      profile: { mid: "u_top_level" },
      base: { profile: { mid: "u_base_level" } },
    }),
    "u_top_level",
  );
}

async function testStorageKeySync(): Promise<void> {
  const testDir = await mkdtemp(join(tmpdir(), "spx-line-e2ee-test-"));
  const objectStoragePath = join(testDir, "linejs-storage-object.json");
  const stringStoragePath = join(testDir, "linejs-storage-string.json");

  try {
    // 1. Graceful when file does not exist
    await syncE2EEStorageKeys(join(testDir, "nonexistent.json"), "u12345");

    // 2. Object-valued storage entries (backward compatibility)
    const initialObjectStorage = {
      authToken: "sample-token",
      "e2eeKeys:5843820": { keyId: 5843820, privKey: "old-priv", pubKey: "old-pub" },
      "e2eeKeys:6030256": { keyId: 6030256, privKey: "new-priv", pubKey: "new-pub" },
      "e2eeKeys:u12345": { keyId: 5843820, privKey: "old-priv", pubKey: "old-pub" },
      "e2eeGroupKeys:c_group_1": { groupKey: "stale-group-key-1" },
      "e2eeGroupKeys:c_group_2": { groupKey: "stale-group-key-2" },
      otherSetting: "keep-this",
    };

    await writeFile(objectStoragePath, JSON.stringify(initialObjectStorage, null, 2), "utf-8");
    await syncE2EEStorageKeys(objectStoragePath, "u12345");

    const updatedObj = JSON.parse(await readFile(objectStoragePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const selfKeyObj = updatedObj["e2eeKeys:u12345"] as { keyId: number; privKey: string };
    assert.equal(selfKeyObj?.keyId, 6030256);
    assert.equal(selfKeyObj?.privKey, "new-priv");
    assert.equal("e2eeGroupKeys:c_group_1" in updatedObj, false);
    assert.equal("e2eeGroupKeys:c_group_2" in updatedObj, false);
    assert.equal(updatedObj.authToken, "sample-token");
    assert.equal(updatedObj.otherSetting, "keep-this");

    await syncE2EEStorageKeys(objectStoragePath, "u12345");
    assert.deepEqual(JSON.parse(await readFile(objectStoragePath, "utf-8")), updatedObj);

    // 3. JSON-string storage entries (real @evex/linejs FileStorage format)
    const newestJson = JSON.stringify({
      keyId: 6030256,
      privKey: "new-priv-b64",
      pubKey: "new-pub-b64",
      e2eeVersion: 1,
    });
    const staleJson = JSON.stringify({
      keyId: 5843820,
      privKey: "old-priv-b64",
      pubKey: "old-pub-b64",
      e2eeVersion: 1,
    });
    const initialStringStorage = {
      "e2eeKeys:5843820": staleJson,
      "e2eeKeys:6030256": newestJson,
      "e2eeKeys:u12345": staleJson,
      "e2eeGroupKeys:c26b64182db598dff5f64867f4275754f": JSON.stringify({
        privKey: "stale-group-b64",
        keyId: 179787746,
      }),
      "e2eePublicKeys:6030256": "raw-base64-public-key==",
    };

    await writeFile(stringStoragePath, JSON.stringify(initialStringStorage, null, 2), "utf-8");
    await syncE2EEStorageKeys(stringStoragePath, "u12345");

    const updatedStr = JSON.parse(await readFile(stringStoragePath, "utf-8")) as Record<
      string,
      unknown
    >;
    assert.equal(typeof updatedStr["e2eeKeys:u12345"], "string");
    assert.equal(updatedStr["e2eeKeys:u12345"], newestJson);
    assert.equal("e2eeGroupKeys:c26b64182db598dff5f64867f4275754f" in updatedStr, false);
    assert.equal(updatedStr["e2eePublicKeys:6030256"], "raw-base64-public-key==");

    const beforeStat = await stat(stringStoragePath);
    await new Promise((r) => setTimeout(r, 20));
    await syncE2EEStorageKeys(stringStoragePath, "u12345");
    const afterStat = await stat(stringStoragePath);
    assert.equal(
      afterStat.mtimeMs,
      beforeStat.mtimeMs,
      "second syncE2EEStorageKeys run should be a no-op when JSON-string self key is already current",
    );

    // 4. Live storage instance (MemoryStorage / FileStorage) routes mutations through storage.set / storage.delete
    //    and ignores corrupt or privKey-less higher-keyId entries.
    const liveMemStorage = new MemoryStorage({
      "e2eeKeys:5843820": staleJson,
      "e2eeKeys:6030256": newestJson,
      "e2eeKeys:9999998": JSON.stringify({ keyId: 9999998, pubKey: "pub-without-priv" }),
      "e2eeKeys:9999999": "{corrupt-json",
      "e2eeKeys:u12345": staleJson,
      "e2eeGroupKeys:c_group_live": JSON.stringify({ privKey: "stale", keyId: 1 }),
    });
    await syncE2EEStorageKeys(join(testDir, "unused-when-live-storage.json"), "u12345", liveMemStorage);
    assert.equal(await liveMemStorage.get("e2eeKeys:u12345"), newestJson);
    assert.equal(await liveMemStorage.get("e2eeGroupKeys:c_group_live"), undefined);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

async function testClientE2EEHardening(): Promise<void> {
  const selfMid = "ub4cd14af4a8aff43c42c71398654aca7";
  const peerMid = "u99999999999999999999999999acda3d";
  const groupMid = "c26b64182db598dff5f64867f4275754f";
  const selfKeyId = 6030256;
  const peerKeyId = 5809465;

  const selfKp = generateKeyPair(Uint8Array.from(clampCurve25519Scalar(randomBytes(32))));
  const peerKp = generateKeyPair(Uint8Array.from(clampCurve25519Scalar(randomBytes(32))));

  const storage = new MemoryStorage();
  const base = new BaseClient({ device: "DESKTOPWIN", storage });
  base.profile = { mid: selfMid, displayName: "Notify" } as unknown as typeof base.profile;

  const selfKeyRecord = {
    keyId: selfKeyId,
    privKey: Buffer.from(selfKp.private).toString("base64"),
    pubKey: Buffer.from(selfKp.public).toString("base64"),
    e2eeVersion: 1,
  };
  await storage.set(`e2eeKeys:${selfKeyId}`, JSON.stringify(selfKeyRecord));
  await storage.set(`e2eeKeys:${selfMid}`, JSON.stringify(selfKeyRecord));
  await storage.set(`e2eePublicKeys:${selfKeyId}`, Buffer.from(selfKp.public).toString("base64"));
  await storage.set(`e2eePublicKeys:${peerKeyId}`, Buffer.from(peerKp.public).toString("base64"));

  let nextRegisteredGroupKeyId = 180000000;
  const serverGroupKeys = new Map<
    number,
    {
      keyVersion: number;
      groupKeyId: number;
      creator: string;
      creatorKeyId: number;
      receiver: string;
      receiverKeyId: number;
      encryptedSharedKey: Buffer;
      allowedTypes: number[];
      specVersion: number;
    }
  >();
  let latestServerGroupKeyId = 0;
  const registerCalls: Array<{
    chatMid: string;
    members: string[];
    keyIds: number[];
    encryptedSharedKeys: Buffer[];
  }> = [];

  const talkStub = base.talk as unknown as Record<string, unknown>;
  talkStub.getLastE2EEPublicKeys = async ({ chatMid }: { chatMid: string }) => {
    assert.equal(chatMid, groupMid);
    return {
      [selfMid]: { keyId: selfKeyId, keyData: Buffer.from(selfKp.public) },
      [peerMid]: { keyId: peerKeyId, keyData: Buffer.from(peerKp.public) },
    };
  };
  talkStub.registerE2EEGroupKey = async (args: {
    keyVersion: number;
    chatMid: string;
    members: string[];
    keyIds: number[];
    encryptedSharedKeys: Buffer[];
  }) => {
    registerCalls.push(args);
    nextRegisteredGroupKeyId += 1;
    const selfIdx = args.members.indexOf(selfMid);
    assert.notEqual(selfIdx, -1);
    const record = {
      keyVersion: args.keyVersion,
      groupKeyId: nextRegisteredGroupKeyId,
      creator: selfMid,
      creatorKeyId: selfKeyId,
      receiver: selfMid,
      receiverKeyId: selfKeyId,
      encryptedSharedKey: Buffer.from(args.encryptedSharedKeys[selfIdx]!),
      allowedTypes: [0, 1, 2, 3, 14, 15],
      specVersion: 2,
    };
    serverGroupKeys.set(record.groupKeyId, record);
    latestServerGroupKeyId = record.groupKeyId;
    return record;
  };
  talkStub.getLastE2EEGroupSharedKey = async ({ chatMid }: { chatMid: string }) => {
    assert.equal(chatMid, groupMid);
    const found = serverGroupKeys.get(latestServerGroupKeyId);
    if (!found) throw new Error("NOT_FOUND");
    return found;
  };
  let historicalLookupCount = 0;
  talkStub.getE2EEGroupSharedKey = async ({
    chatMid,
    groupKeyId,
  }: {
    keyVersion: number;
    chatMid: string;
    groupKeyId: number;
  }) => {
    assert.equal(chatMid, groupMid);
    historicalLookupCount += 1;
    const found = serverGroupKeys.get(groupKeyId);
    if (!found) throw new Error(`Group key ${groupKeyId} not found`);
    return found;
  };

  const clientWrapper = {
    base,
    authToken: "test-token",
    on() {},
    listen() {},
  };

  // Install hardening twice to verify idempotence
  installLineClientE2EEHardening(clientWrapper as never);
  installLineClientE2EEHardening(clientWrapper as never);

  // 1. All 32 group key registrations must produce clamped Curve25519 scalars for all members
  for (let i = 0; i < 32; i += 1) {
    await base.e2ee.tryRegisterE2EEGroupKey(groupMid);
    const call = registerCalls.at(-1)!;
    const selfIdx = call.members.indexOf(selfMid);
    const peerIdx = call.members.indexOf(peerMid);
    const selfDecrypted = decryptGroupKeyForMember(
      selfKp.private,
      selfKp.public,
      call.encryptedSharedKeys[selfIdx]!,
    );
    const peerDecrypted = decryptGroupKeyForMember(
      peerKp.private,
      selfKp.public,
      call.encryptedSharedKeys[peerIdx]!,
    );
    assert.deepEqual(selfDecrypted, peerDecrypted);
    assert.equal(
      isClampedCurve25519Scalar(selfDecrypted),
      true,
      `iteration ${i}: registered group key must be Curve25519-clamped`,
    );
  }

  // 2. Seed an unclamped group key on server (like 179787746 with bit 255 = 1) and verify
  //    sending an outgoing message auto-rotates to a new clamped group key!
  const unclampedGroupPriv = Buffer.from(clampCurve25519Scalar(randomBytes(32)));
  unclampedGroupPriv[31]! |= 0x80;
  const brokenGroupKeyId = 179787746;
  serverGroupKeys.set(brokenGroupKeyId, {
    keyVersion: 1,
    groupKeyId: brokenGroupKeyId,
    creator: selfMid,
    creatorKeyId: selfKeyId,
    receiver: selfMid,
    receiverKeyId: selfKeyId,
    encryptedSharedKey: encryptGroupKeyForMember(selfKp.private, selfKp.public, unclampedGroupPriv),
    allowedTypes: [0, 1, 2, 3, 14, 15],
    specVersion: 2,
  });
  latestServerGroupKeyId = brokenGroupKeyId;
  await storage.delete(`e2eeGroupKeys:${groupMid}`);

  const callsBeforeSend = registerCalls.length;
  const outgoingChunks = await base.e2ee.encryptE2EEMessage(groupMid, "แจ้งเตือนงานใหม่ SPX", 0);
  assert.equal(
    registerCalls.length,
    callsBeforeSend + 1,
    "encryptE2EEMessage must auto-rotate when server latest group key is unclamped",
  );
  const rotatedKeyId = outgoingChunks[4]!.readInt32BE(0);
  assert.notEqual(rotatedKeyId, brokenGroupKeyId);
  assert.equal(rotatedKeyId, latestServerGroupKeyId);

  // Verify Official LINE (using 256-bit unclamped X25519) decrypts our outgoing message!
  const lastCall = registerCalls.at(-1)!;
  const rotatedPrivForPeer = decryptGroupKeyForMember(
    peerKp.private,
    selfKp.public,
    lastCall.encryptedSharedKeys[lastCall.members.indexOf(peerMid)]!,
  );
  const officialSharedSecret = x25519Unclamped(rotatedPrivForPeer, selfKp.public);
  const officialGcmKey = sha256Concat(officialSharedSecret, outgoingChunks[0]!, "Key");
  const officialAad = Buffer.concat([
    Buffer.from(groupMid),
    Buffer.from(selfMid),
    outgoingChunks[3]!,
    outgoingChunks[4]!,
    int32BytesBE(2),
    int32BytesBE(0),
  ]);
  const officialDecipher = createDecipheriv("aes-256-gcm", officialGcmKey, outgoingChunks[2]!);
  officialDecipher.setAAD(officialAad);
  officialDecipher.setAuthTag(outgoingChunks[1]!.subarray(-16));
  const officialPlain = Buffer.concat([
    officialDecipher.update(outgoingChunks[1]!.subarray(0, -16)),
    officialDecipher.final(),
  ]).toString("utf-8");
  assert.deepEqual(JSON.parse(officialPlain), { text: "แจ้งเตือนงานใหม่ SPX" });

  // 3. Historical groupKeyId lookup via getE2EEGroupSharedKey + Official LINE unclamped fallback
  //    3a-i: 179787746 was already seen during auto-rotation, so historicalGroupKeyCache serves it with 0 RPCs
  const officialTextChunks = encryptOfficialLineGroupV2Chunks({
    groupPriv: unclampedGroupPriv,
    senderPub: peerKp.public,
    senderKeyId: peerKeyId,
    groupKeyId: brokenGroupKeyId,
    to: groupMid,
    from: peerMid,
    payload: { text: "!status" },
    contentType: 0,
  });
  const decryptedTextMsg = await base.e2ee.decryptE2EEMessage({
    id: "640260327610778268",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "NONE",
    contentMetadata: { e2eeVersion: "2" },
    chunks: officialTextChunks,
  } as never);
  assert.equal(decryptedTextMsg.text, "!status");
  assert.equal(historicalLookupCount, 0);

  //    3a-ii: A pre-restart historical groupKeyId (179700001) never seen in this process triggers
  //           exactly 1 getE2EEGroupSharedKey RPC on first message and 0 extra RPCs on subsequent messages
  const preRestartHistoricalKeyId = 179700001;
  const preRestartUnclampedPriv = Buffer.from(clampCurve25519Scalar(randomBytes(32)));
  preRestartUnclampedPriv[31]! |= 0x80;
  serverGroupKeys.set(preRestartHistoricalKeyId, {
    keyVersion: 1,
    groupKeyId: preRestartHistoricalKeyId,
    creator: selfMid,
    creatorKeyId: selfKeyId,
    receiver: selfMid,
    receiverKeyId: selfKeyId,
    encryptedSharedKey: encryptGroupKeyForMember(
      selfKp.private,
      selfKp.public,
      preRestartUnclampedPriv,
    ),
    allowedTypes: [0, 1, 2, 3, 14, 15],
    specVersion: 2,
  });

  const preRestartTextChunks = encryptOfficialLineGroupV2Chunks({
    groupPriv: preRestartUnclampedPriv,
    senderPub: peerKp.public,
    senderKeyId: peerKeyId,
    groupKeyId: preRestartHistoricalKeyId,
    to: groupMid,
    from: peerMid,
    payload: { text: "!routes" },
    contentType: 0,
  });
  const decryptedPreRestartMsg = await base.e2ee.decryptE2EEMessage({
    id: "640260327610778267",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "NONE",
    contentMetadata: { e2eeVersion: "2" },
    chunks: preRestartTextChunks,
  } as never);
  assert.equal(decryptedPreRestartMsg.text, "!routes");
  assert.equal(historicalLookupCount, 1);

  // Cached latest key should remain rotatedKeyId (not clobbered by older historical keys)
  const cachedAfterHistorical = JSON.parse(
    (await storage.get(`e2eeGroupKeys:${groupMid}`)) as string,
  ) as { keyId: number };
  assert.equal(cachedAfterHistorical.keyId, rotatedKeyId);

  // Official LINE encrypted IMAGE metadata (decryptE2EEDataMessage) on preRestartHistoricalKeyId hits in-memory cache
  const officialImageChunks = encryptOfficialLineGroupV2Chunks({
    groupPriv: preRestartUnclampedPriv,
    senderPub: peerKp.public,
    senderKeyId: peerKeyId,
    groupKeyId: preRestartHistoricalKeyId,
    to: groupMid,
    from: peerMid,
    payload: { keyMaterial: "obs-file-key-material-b64", fileName: "booking.jpg" },
    contentType: 1,
  });
  const decryptedImageMeta = await base.e2ee.decryptE2EEDataMessage({
    id: "640260312964268364",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "IMAGE",
    contentMetadata: { e2eeVersion: "2" },
    chunks: officialImageChunks,
  } as never);
  assert.equal(decryptedImageMeta.keyMaterial, "obs-file-key-material-b64");
  assert.equal(
    historicalLookupCount,
    1,
    "second message on historical groupKeyId must hit bounded in-memory cache without extra RPC",
  );

  // 3b. Hardened generateSharedSecret must reject low-order Curve25519 public keys
  assert.throws(
    () => base.e2ee.generateSharedSecret(Buffer.from(selfKp.private), Buffer.alloc(32, 0)),
    /low-order|invalid/i,
  );

  // 3c. Secondary-device / rotated peer user keyId fallback via talk.getE2EEPublicKey
  //     (when negotiateE2EEPublicKey returns a newer primary keyId != senderKeyId) + UTF-8 string keyData
  const secondaryDeviceKeyId = 6123456;
  // Deterministic 32-byte Curve25519 scalar -> public key; also test UTF-8 string decoding when valid UTF-8
  const secondaryDeviceKp = generateKeyPair(
    Uint8Array.from(clampCurve25519Scalar(Buffer.alloc(32, 0x42))),
  );
  talkStub.negotiateE2EEPublicKey = async ({ mid }: { mid: string }) => ({
    mid,
    specVersion: 2,
    publicKey: {
      keyId: 9999999,
      keyData: Buffer.from(peerKp.public),
    },
  });
  let exactUserPubKeyLookups = 0;
  talkStub.getE2EEPublicKey = async ({
    mid,
    keyVersion,
    keyId,
  }: {
    mid: string;
    keyVersion: number;
    keyId: number;
  }) => {
    assert.equal(mid, peerMid);
    assert.equal(keyVersion, 1);
    assert.equal(keyId, secondaryDeviceKeyId);
    exactUserPubKeyLookups += 1;
    return {
      version: 1,
      keyId: secondaryDeviceKeyId,
      keyData: Buffer.from(secondaryDeviceKp.public),
    };
  };
  const secondaryDeviceChunks = encryptOfficialLineGroupV2Chunks({
    groupPriv: unclampedGroupPriv,
    senderPub: secondaryDeviceKp.public,
    senderKeyId: secondaryDeviceKeyId,
    groupKeyId: brokenGroupKeyId,
    to: groupMid,
    from: peerMid,
    payload: { text: "+BKK-CNX" },
    contentType: 0,
  });
  const decryptedSecondaryMsg = await base.e2ee.decryptE2EEMessage({
    id: "640260327610778269",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "NONE",
    contentMetadata: { e2eeVersion: "2" },
    chunks: secondaryDeviceChunks,
  } as never);
  assert.equal(decryptedSecondaryMsg.text, "+BKK-CNX");
  assert.equal(exactUserPubKeyLookups, 1);

  // Also verify Thrift UTF-8 string-decoded binary keyData (containing multi-byte UTF-8 >= 0x80)
  const utf8BinaryPubKey = Buffer.concat([
    Buffer.from("กข", "utf-8"), // 6 bytes with multi-byte UTF-8 (>= 0x80)
    Buffer.alloc(26, 0x31),
  ]);
  assert.equal(utf8BinaryPubKey.byteLength, 32);
  const utf8KeyId = 6123457;
  talkStub.getE2EEPublicKey = async ({ keyId }: { keyId: number }) => ({
    version: 1,
    keyId,
    keyData: utf8BinaryPubKey.toString("utf-8"),
  });
  const fetchedUtf8Pub = await base.e2ee.getE2EELocalPublicKey(peerMid, utf8KeyId);
  assert.deepEqual(fetchedUtf8Pub, utf8BinaryPubKey);

  // 3d. LOCATION E2EE message ("LOCATION" -> contentType 15 in AAD) under unclamped group key
  const officialLocationChunks = encryptOfficialLineGroupV2Chunks({
    groupPriv: unclampedGroupPriv,
    senderPub: peerKp.public,
    senderKeyId: peerKeyId,
    groupKeyId: brokenGroupKeyId,
    to: groupMid,
    from: peerMid,
    payload: { location: { title: "SPX Hub", latitude: 13.7563, longitude: 100.5018 } },
    contentType: 15,
  });
  const decryptedLocationMsg = await base.e2ee.decryptE2EEMessage({
    id: "640260327610778270",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "LOCATION",
    contentMetadata: { e2eeVersion: "2" },
    chunks: officialLocationChunks,
  } as never);
  assert.deepEqual(decryptedLocationMsg.location, {
    title: "SPX Hub",
    latitude: 13.7563,
    longitude: 100.5018,
  });

  // 4. Corrupted / malformed short chunks in decryptE2EEMessage & decryptE2EEMessageV2 must NOT crash
  assert.throws(() =>
    base.e2ee.decryptE2EEMessageV2(
      groupMid,
      peerMid,
      [Buffer.alloc(16), Buffer.alloc(8)],
      unclampedGroupPriv,
      Buffer.from(peerKp.public),
      2,
      0,
    ),
  );
  const corruptedChunks = officialTextChunks.map((buf) => Buffer.from(buf));
  corruptedChunks[1]![corruptedChunks[1]!.length - 1]! ^= 0xff;
  const safeFallbackMsg = await base.e2ee.decryptE2EEMessage({
    id: "640291590292373983",
    from: peerMid,
    to: groupMid,
    toType: "GROUP",
    contentType: "NONE",
    contentMetadata: { e2eeVersion: "2" },
    chunks: corruptedChunks,
  } as never);
  assert.equal(safeFallbackMsg.id, "640291590292373983");
  assert.equal(safeFallbackMsg.text, undefined);

  // 5. Real LINE TalkServer deduplication behavior: when (members, keyIds) has not changed,
  //    registerE2EEGroupKey returns the existing 179787746 groupKeyId WITHOUT encryptedSharedKey!
  //    Verify:
  //      - cached storage retains the true 179787746 key (never poisoned by discarded candidate key!),
  //      - outgoing encryptE2EEMessage uses 256-bit unclamped X25519 so Official LINE decrypts it,
  //      - second send does not spam registerE2EEGroupKey again for the same unclamped keyId.
  latestServerGroupKeyId = brokenGroupKeyId;
  await storage.delete(`e2eeGroupKeys:${groupMid}`);
  let dedupRegisterAttempts = 0;
  talkStub.registerE2EEGroupKey = async () => {
    dedupRegisterAttempts += 1;
    return {
      keyVersion: 1,
      groupKeyId: brokenGroupKeyId,
      creator: selfMid,
      creatorKeyId: selfKeyId,
      receiver: selfMid,
      receiverKeyId: selfKeyId,
      encryptedSharedKey: undefined as unknown as Buffer,
      allowedTypes: [0, 1, 2, 3, 14, 15],
      specVersion: 2,
    };
  };

  const dedupChunks1 = await base.e2ee.encryptE2EEMessage(groupMid, "งานด่วน boT #1", 0);
  const dedupChunks2 = await base.e2ee.encryptE2EEMessage(groupMid, "งานด่วน boT #2", 0);
  assert.equal(
    dedupRegisterAttempts,
    1,
    "should attempt rotation at most once per unclamped server groupKeyId when TalkServer deduplicates",
  );
  assert.equal(dedupChunks1[4]!.readInt32BE(0), brokenGroupKeyId);
  assert.equal(dedupChunks2[4]!.readInt32BE(0), brokenGroupKeyId);

  const cachedDedup = JSON.parse((await storage.get(`e2eeGroupKeys:${groupMid}`)) as string) as {
    keyId: number;
    privKey: string;
  };
  assert.equal(cachedDedup.keyId, brokenGroupKeyId);
  assert.equal(cachedDedup.privKey, unclampedGroupPriv.toString("base64"));

  for (const [chunks, expectedText] of [
    [dedupChunks1, "งานด่วน boT #1"],
    [dedupChunks2, "งานด่วน boT #2"],
  ] as const) {
    const shared = x25519Unclamped(unclampedGroupPriv, selfKp.public);
    const gcmKey = sha256Concat(shared, chunks[0]!, "Key");
    const aad = Buffer.concat([
      Buffer.from(groupMid),
      Buffer.from(selfMid),
      chunks[3]!,
      chunks[4]!,
      int32BytesBE(2),
      int32BytesBE(0),
    ]);
    const dec = createDecipheriv("aes-256-gcm", gcmKey, chunks[2]!);
    dec.setAAD(aad);
    dec.setAuthTag(chunks[1]!.subarray(-16));
    const plain = Buffer.concat([
      dec.update(chunks[1]!.subarray(0, -16)),
      dec.final(),
    ]).toString("utf-8");
    assert.deepEqual(JSON.parse(plain), { text: expectedText });
  }
}

async function run(): Promise<void> {
  await testCurve25519Primitives();
  await testStorageKeySync();
  await testClientE2EEHardening();
  console.log("line-bot-e2ee-sync: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
