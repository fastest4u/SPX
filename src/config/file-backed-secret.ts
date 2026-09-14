import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { TextDecoder } from "node:util";

const secretNamePattern = /^[A-Z][A-Z0-9_]*$/;
const maxSecretFileBytes = 64 * 1024;

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedSecretFile(path: string, fileVariable: string): string {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxSecretFileBytes) {
      throw new Error("invalid secret file");
    }

    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("secret file changed before read");
    }

    const buffer = Buffer.allocUnsafe(maxSecretFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxSecretFileBytes) throw new Error("secret file exceeds size limit");

    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || after.size !== BigInt(length)) {
      throw new Error("secret file changed during read");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).trim();
  } catch {
    throw new Error(`${fileVariable} could not be read`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The read result is already invalid if the descriptor cannot close cleanly.
      }
    }
  }
}

export function loadFileBackedSecret(name: string): boolean {
  if (!secretNamePattern.test(name)) {
    throw new Error("file-backed secret name is invalid");
  }

  const fileVariable = `${name}_FILE`;
  const path = process.env[fileVariable]?.trim();
  if (!path) return false;

  if ((process.env[name] ?? "").trim() !== "") {
    throw new Error(`${name} and ${fileVariable} are mutually exclusive`);
  }

  const value = readBoundedSecretFile(path, fileVariable);
  if (!value) throw new Error(`${fileVariable} must not be empty`);

  process.env[name] = value;
  return true;
}
