#!/usr/local/bin/node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import {
  constants,
  lstatSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const PRODUCTION_KEYRING_PATH = "/etc/spx-kms/keyring.json";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATABASE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPERATIONS = new Set(["encrypt", "decrypt", "sign"]);
const MAX_PROTECTED_FILE_BYTES = 1024 * 1024;
const METADATA_NAME = "encryption-metadata.json";

function fail(code) {
  throw new Error(code);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function assertNoSymlinkComponents(path, allowMissingLeaf = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === "ENOENT") return absolute;
      fail("protected-path-invalid");
    }
    if (stat.isSymbolicLink()) fail("protected-path-invalid");
    if (index < parts.length - 1 && !stat.isDirectory()) fail("protected-path-invalid");
  }
  return absolute;
}

async function readProtectedJson(path, label, options = {}) {
  const absolute = assertNoSymlinkComponents(path);
  let before;
  try {
    before = await lstat(absolute, { bigint: true });
  } catch {
    fail("protected-file-invalid");
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.size <= 0n
    || before.size > BigInt(options.maxBytes ?? MAX_PROTECTED_FILE_BYTES)
    || (
      process.platform !== "win32"
      && (
        Number(before.mode & 0o777n) !== (options.mode ?? 0o400)
        || (!options.allowNonRoot && before.uid !== 0n)
      )
    )
  ) fail("protected-file-invalid");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeNs !== before.mtimeNs
      || opened.ctimeNs !== before.ctimeNs
    ) fail("protected-file-invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || after.size !== BigInt(bytes.length)
    ) fail("protected-file-invalid");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${label}-invalid`);
    }
  } catch (error) {
    if (error instanceof Error && /^[a-z0-9-]+$/.test(error.message)) throw error;
    fail("protected-file-invalid");
  } finally {
    await handle?.close();
  }
}

function validateCapability(value) {
  if (!exactKeys(value, ["schemaVersion", "capabilityId", "grants"])) fail("capability-invalid");
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.capabilityId ?? "") || !Array.isArray(value.grants)) {
    fail("capability-invalid");
  }
  const seen = new Set();
  for (const grant of value.grants) {
    if (
      !exactKeys(grant, ["operation", "keyId"])
      || !OPERATIONS.has(grant.operation)
      || !SAFE_ID.test(grant.keyId ?? "")
    ) fail("capability-invalid");
    const identity = `${grant.operation}:${grant.keyId}`;
    if (seen.has(identity)) fail("capability-invalid");
    seen.add(identity);
  }
  if (seen.size === 0) fail("capability-invalid");
  return seen;
}

function validateKeyring(value) {
  if (!exactKeys(value, ["schemaVersion", "keys"]) || value.schemaVersion !== 1) fail("keyring-invalid");
  if (value.keys === null || typeof value.keys !== "object" || Array.isArray(value.keys)) fail("keyring-invalid");
  for (const [keyId, key] of Object.entries(value.keys)) {
    if (!SAFE_ID.test(keyId)) fail("keyring-invalid");
    if (key?.algorithm === "AES-256-GCM") {
      if (!exactKeys(key, ["algorithm", "keyBase64"]) || !BASE64.test(key.keyBase64 ?? "")) fail("keyring-invalid");
      const bytes = Buffer.from(key.keyBase64, "base64");
      if (bytes.length !== 32 || bytes.toString("base64") !== key.keyBase64) fail("keyring-invalid");
    } else if (key?.algorithm === "Ed25519") {
      if (!exactKeys(key, ["algorithm", "privateKeyPemBase64"]) || !BASE64.test(key.privateKeyPemBase64 ?? "")) {
        fail("keyring-invalid");
      }
      try {
        const privateKey = createPrivateKey(Buffer.from(key.privateKeyPemBase64, "base64"));
        if (privateKey.asymmetricKeyType !== "ed25519") fail("keyring-invalid");
      } catch {
        fail("keyring-invalid");
      }
    } else {
      fail("keyring-invalid");
    }
  }
  return value.keys;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || !OPERATIONS.has(argv[0])) fail("arguments-invalid");
  const operation = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== "string" || !name.startsWith("--") || typeof value !== "string" || values.has(name)) {
      fail("arguments-invalid");
    }
    values.set(name, value);
  }
  const expected = operation === "encrypt"
    ? ["--capability-file", "--key-id", "--release-sha", "--database-fingerprint", "--ciphertext-output", "--metadata-output"]
    : operation === "decrypt"
      ? ["--capability-file", "--key-id", "--release-sha", "--database-fingerprint", "--input"]
      : ["--capability-file", "--key-id", "--subject-sha256"];
  if (values.size !== expected.length || expected.some((name) => !values.has(name))) fail("arguments-invalid");
  const keyId = values.get("--key-id");
  const capabilityFile = values.get("--capability-file");
  if (!SAFE_ID.test(keyId ?? "") || !isAbsolute(capabilityFile ?? "")) fail("arguments-invalid");
  if (operation === "sign") {
    if (!SHA256.test(values.get("--subject-sha256") ?? "")) fail("arguments-invalid");
  } else {
    if (
      !SHA40.test(values.get("--release-sha") ?? "")
      || !DATABASE_FINGERPRINT.test(values.get("--database-fingerprint") ?? "")
    ) fail("arguments-invalid");
    const pathNames = operation === "encrypt"
      ? ["--ciphertext-output", "--metadata-output"]
      : ["--input"];
    if (pathNames.some((name) => !isAbsolute(values.get(name) ?? ""))) fail("arguments-invalid");
    if (
      operation === "encrypt"
      && (resolve(values.get("--ciphertext-output")) === resolve(values.get("--metadata-output"))
        || basename(values.get("--metadata-output")) !== METADATA_NAME
        || dirname(resolve(values.get("--ciphertext-output"))) !== dirname(resolve(values.get("--metadata-output"))))
    ) fail("arguments-invalid");
  }
  return Object.freeze({ operation, values, keyId, capabilityFile });
}

async function assertSecureOutputParent(path, allowNonRoot) {
  const absolute = assertNoSymlinkComponents(path, true);
  const parent = assertNoSymlinkComponents(dirname(absolute));
  const stat = await lstat(parent, { bigint: true });
  if (
    !stat.isDirectory()
    || (
      process.platform !== "win32"
      && ((stat.mode & 0o022n) !== 0n || (!allowNonRoot && stat.uid !== 0n))
    )
  ) fail("output-path-invalid");
  try {
    await lstat(absolute);
    fail("output-path-invalid");
  } catch (error) {
    if (error instanceof Error && error.message === "output-path-invalid") throw error;
    if (error?.code !== "ENOENT") fail("output-path-invalid");
  }
  return absolute;
}

function hashTap(hash, counter) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      counter.bytes += bytes.length;
      callback(null, bytes);
    },
  });
}

async function writeExclusiveTemporary(finalPath, producer) {
  const temporary = `${finalPath}.${process.pid}.${randomBytes(12).toString("hex")}.pending`;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    await producer(handle);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await link(temporary, finalPath);
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function atomicJson(path, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  await writeExclusiveTemporary(path, async (handle) => {
    await handle.writeFile(bytes);
  });
}

function destinationSink(destination) {
  return new Writable({
    write(chunk, _encoding, callback) {
      destination.write(chunk, callback);
    },
  });
}

function fileHandleSink(handle) {
  return new Writable({
    write(chunk, _encoding, callback) {
      (async () => {
        const bytes = Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset);
          if (result.bytesWritten === 0) fail("kms-operation-failed");
          offset += result.bytesWritten;
        }
      })().then(() => callback(), callback);
    },
  });
}

async function encryptBackup(parsed, key, options) {
  const ciphertextOutput = await assertSecureOutputParent(
    parsed.values.get("--ciphertext-output"),
    options.allowNonRoot,
  );
  const metadataOutput = await assertSecureOutputParent(
    parsed.values.get("--metadata-output"),
    options.allowNonRoot,
  );
  const iv = randomBytes(12);
  const aad = Object.freeze({
    schemaVersion: 1,
    algorithm: "AES-256-GCM",
    keyId: parsed.keyId,
    releaseSha: parsed.values.get("--release-sha"),
    databaseFingerprint: parsed.values.get("--database-fingerprint"),
    ivBase64: iv.toString("base64"),
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(canonicalJson(aad), "utf8"));
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const plaintextCounter = { bytes: 0 };
  const ciphertextCounter = { bytes: 0 };
  let ciphertextPublished = false;
  try {
    await writeExclusiveTemporary(ciphertextOutput, async (handle) => {
      await pipeline(
        options.stdin ?? process.stdin,
        hashTap(plaintextHash, plaintextCounter),
        cipher,
        hashTap(ciphertextHash, ciphertextCounter),
        fileHandleSink(handle),
      );
    });
    ciphertextPublished = true;
    const metadata = Object.freeze({
      ...aad,
      authTagBase64: cipher.getAuthTag().toString("base64"),
      plaintextSha256: plaintextHash.digest("hex"),
      ciphertextSha256: ciphertextHash.digest("hex"),
      plaintextBytes: plaintextCounter.bytes,
      ciphertextBytes: ciphertextCounter.bytes,
    });
    await atomicJson(metadataOutput, metadata);
  } catch {
    if (ciphertextPublished) await unlink(ciphertextOutput).catch(() => {});
    fail("kms-operation-failed");
  }
}

function validateMetadata(value, parsed) {
  const keys = [
    "schemaVersion", "algorithm", "keyId", "releaseSha", "databaseFingerprint", "ivBase64",
    "authTagBase64", "plaintextSha256", "ciphertextSha256", "plaintextBytes", "ciphertextBytes",
  ];
  if (
    !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.algorithm !== "AES-256-GCM"
    || value.keyId !== parsed.keyId
    || value.releaseSha !== parsed.values.get("--release-sha")
    || value.databaseFingerprint !== parsed.values.get("--database-fingerprint")
    || !BASE64.test(value.ivBase64 ?? "")
    || Buffer.from(value.ivBase64, "base64").length !== 12
    || !BASE64.test(value.authTagBase64 ?? "")
    || Buffer.from(value.authTagBase64, "base64").length !== 16
    || !SHA256.test(value.plaintextSha256 ?? "")
    || !SHA256.test(value.ciphertextSha256 ?? "")
    || !Number.isSafeInteger(value.plaintextBytes)
    || value.plaintextBytes < 0
    || !Number.isSafeInteger(value.ciphertextBytes)
    || value.ciphertextBytes < 0
  ) fail("metadata-invalid");
  return value;
}

async function decryptBackup(parsed, key, options) {
  const input = assertNoSymlinkComponents(parsed.values.get("--input"));
  const inputStat = await lstat(input, { bigint: true }).catch(() => fail("ciphertext-invalid"));
  if (
    !inputStat.isFile()
    || inputStat.isSymbolicLink()
    || (process.platform !== "win32" && (Number(inputStat.mode & 0o777n) !== 0o600
      || (!options.allowNonRoot && inputStat.uid !== 0n)))
  ) fail("ciphertext-invalid");
  const metadataPath = resolve(dirname(input), METADATA_NAME);
  const metadata = validateMetadata(await readProtectedJson(
    metadataPath,
    "metadata",
    { mode: 0o600, allowNonRoot: options.allowNonRoot },
  ), parsed);
  const aad = {
    schemaVersion: metadata.schemaVersion,
    algorithm: metadata.algorithm,
    keyId: metadata.keyId,
    releaseSha: metadata.releaseSha,
    databaseFingerprint: metadata.databaseFingerprint,
    ivBase64: metadata.ivBase64,
  };
  const makeDecipher = () => {
    const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(metadata.ivBase64, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(canonicalJson(aad), "utf8"));
  decipher.setAuthTag(Buffer.from(metadata.authTagBase64, "base64"));
    return decipher;
  };
  const plaintextHash = createHash("sha256");
  const plaintextCounter = { bytes: 0 };
  const ciphertextHash = createHash("sha256");
  const ciphertextCounter = { bytes: 0 };
  const snapshotPath = `${input}.${process.pid}.${randomBytes(12).toString("hex")}.verified`;
  await assertSecureOutputParent(snapshotPath, options.allowNonRoot);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let source;
  let snapshot;
  let snapshotOwned = false;
  try {
    source = await open(input, constants.O_RDONLY | noFollow);
    const opened = await source.stat({ bigint: true });
    if (opened.ino !== inputStat.ino || opened.dev !== inputStat.dev
      || opened.ctimeNs !== inputStat.ctimeNs || opened.size !== inputStat.size) fail("ciphertext-invalid");
    snapshot = await open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
    snapshotOwned = true;
    if (process.platform !== "win32") {
      await unlink(snapshotPath);
      snapshotOwned = false;
    }
    await pipeline(
      readHandle(source), hashTap(ciphertextHash, ciphertextCounter), fileHandleSink(snapshot),
    );
    if (ciphertextHash.digest("hex") !== metadata.ciphertextSha256
      || ciphertextCounter.bytes !== metadata.ciphertextBytes) fail("ciphertext-invalid");
    // Authenticate an immutable private ciphertext snapshot before releasing any restore bytes.
    await pipeline(
      readHandle(snapshot), makeDecipher(),
      hashTap(plaintextHash, plaintextCounter),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    );
    if (plaintextHash.digest("hex") !== metadata.plaintextSha256
      || plaintextCounter.bytes !== metadata.plaintextBytes) fail("ciphertext-invalid");
    await pipeline(readHandle(snapshot), makeDecipher(), destinationSink(options.stdout ?? process.stdout));
  } catch {
    fail("ciphertext-invalid");
  } finally {
    await source?.close();
    await snapshot?.close();
    if (snapshotOwned) await unlink(snapshotPath);
  }
}

function readHandle(handle) {
  return Readable.from((async function* () {
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  })());
}

async function writeOutput(destination, bytes) {
  await new Promise((resolveWrite, rejectWrite) => {
    destination.write(bytes, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

async function signHash(parsed, key, options) {
  const privateKey = createPrivateKey(Buffer.from(key.privateKeyPemBase64, "base64"));
  const signature = sign(null, Buffer.from(parsed.values.get("--subject-sha256"), "hex"), privateKey);
  await writeOutput(
    options.stdout ?? process.stdout,
    Buffer.from(`${JSON.stringify({ signatureBase64: signature.toString("base64") })}\n`, "utf8"),
  ).catch(() => fail("kms-operation-failed"));
}

export async function executeKmsEnvelope(argv, options = {}) {
  const parsed = parseArguments(argv);
  const allowNonRoot = options.allowNonRoot === true;
  const capability = validateCapability(await readProtectedJson(
    parsed.capabilityFile,
    "capability",
    { mode: 0o400, allowNonRoot },
  ));
  if (!capability.has(`${parsed.operation}:${parsed.keyId}`)) fail("capability-denied");
  const keyringPath = options.keyringPath ?? PRODUCTION_KEYRING_PATH;
  if (!isAbsolute(keyringPath)) fail("keyring-invalid");
  const keys = validateKeyring(await readProtectedJson(
    keyringPath,
    "keyring",
    { mode: 0o400, allowNonRoot },
  ));
  const key = keys[parsed.keyId];
  if (!key) fail("key-not-found");
  if (parsed.operation === "sign") {
    if (key.algorithm !== "Ed25519") fail("key-algorithm-invalid");
    await signHash(parsed, key, options);
    return;
  }
  if (key.algorithm !== "AES-256-GCM") fail("key-algorithm-invalid");
  const keyBytes = Buffer.from(key.keyBase64, "base64");
  try {
    if (parsed.operation === "encrypt") await encryptBackup(parsed, keyBytes, { ...options, allowNonRoot });
    else await decryptBackup(parsed, keyBytes, { ...options, allowNonRoot });
  } finally {
    keyBytes.fill(0);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  executeKmsEnvelope(process.argv.slice(2)).catch(() => {
    process.stderr.write("spx-kms-envelope-failed\n");
    process.exitCode = 1;
  });
}
