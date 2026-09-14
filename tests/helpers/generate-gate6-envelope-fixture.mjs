#!/usr/bin/env node
import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

import {
  canonicalGate6Json,
  createGate6ActionIndex,
  createGate6EnvelopeCore,
} from "../../src/services/gate6-approval-runtime.mjs";

const FIXTURE_PATH = new URL("../fixtures/gate6-envelope.complete.json", import.meta.url);
const KEY_ID = "gate6-production-test-fixture";
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("gate6-production-fixture-seed!!!", "utf8"),
  ]),
  format: "der",
  type: "pkcs8",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signed(payload) {
  const canonical = canonicalGate6Json(payload);
  return {
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId: KEY_ID,
      signedPayloadSha256: sha256(canonical),
      signatureBase64: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  };
}

const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
const migrations = JSON.parse(await readFile(new URL("../../migrations/released-checksums.json", import.meta.url), "utf8"));
fixture.installedSchemaVersion = Math.max(...Object.keys(migrations).map((name) => Number(name.slice(0, 3))));
const envelopeCoreSha256 = sha256(canonicalGate6Json(createGate6EnvelopeCore(fixture)));
fixture.envelopeCoreSha256 = envelopeCoreSha256;
fixture.actionApprovals = fixture.actionApprovals.map((action) => {
  const { signature: _signature, ...payload } = action;
  return signed({ ...payload, envelopeCoreSha256 });
});
const actionIndexSha256 = sha256(canonicalGate6Json(createGate6ActionIndex(fixture.actionApprovals)));
fixture.actionIndexSha256 = actionIndexSha256;
fixture.signature = signed({ envelopeCoreSha256, actionIndexSha256 }).signature;

await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
