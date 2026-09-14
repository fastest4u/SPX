import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const INVALID_SECRET_ERROR = "file-backed-secret-invalid";

function fail() {
  throw new Error(INVALID_SECRET_ERROR);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedSecretFile(path) {
  let descriptor;
  let valid = false;
  let value = "";
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > BigInt(MAX_SECRET_FILE_BYTES)
    ) {
      fail();
    }

    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) fail();

    const buffer = Buffer.allocUnsafe(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SECRET_FILE_BYTES) fail();

    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || after.size !== BigInt(length)) fail();

    value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).trim();
    if (value === "") fail();
    valid = true;
  } catch {
    valid = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        valid = false;
      }
    }
  }

  if (!valid) fail();
  return value;
}

export function resolveFileBackedSecret(name, env = process.env) {
  if (!SECRET_NAME_PATTERN.test(name) || !env || typeof env !== "object" || Array.isArray(env)) {
    fail();
  }

  const plainValue = typeof env[name] === "string" ? env[name].trim() : "";
  const fileName = `${name}_FILE`;
  const filePath = typeof env[fileName] === "string" ? env[fileName].trim() : "";

  if (plainValue !== "" && filePath !== "") fail();
  if (plainValue !== "") return plainValue;
  if (filePath === "") return "";
  return readBoundedSecretFile(filePath);
}
