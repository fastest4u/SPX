import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { parse, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function sanitizedError(label, reason) {
  return new Error(`${label} ${reason}`);
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertNoSymlinkComponents(path, label) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = root;
  for (let index = 0; index < remainder.length; index += 1) {
    current = resolve(current, remainder[index]);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch {
      throw sanitizedError(label, "is unavailable");
    }
    if (stat.isSymbolicLink()) throw sanitizedError(label, "must not traverse a symlink");
    if (index < remainder.length - 1 && !stat.isDirectory()) {
      throw sanitizedError(label, "has a non-directory parent");
    }
  }
  return absolute;
}

export function readStableRegularFile(path, label, options = {}) {
  if (typeof label !== "string" || !/^[A-Za-z0-9 ._()-]{1,120}$/.test(label)) {
    throw new Error("safe file label is invalid");
  }
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("safe file maximumBytes is invalid");
  }
  const absolute = assertNoSymlinkComponents(path, label);
  let beforePath;
  try {
    beforePath = lstatSync(absolute, { bigint: true });
  } catch {
    throw sanitizedError(label, "is unavailable");
  }
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw sanitizedError(label, "must be a regular non-symlink file");
  }
  if (beforePath.size > BigInt(maximumBytes)) throw sanitizedError(label, "exceeds its size limit");

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = openSync(absolute, constants.O_RDONLY | noFollow);
  } catch {
    throw sanitizedError(label, "could not be opened safely");
  }
  try {
    const beforeFd = fstatSync(handle, { bigint: true });
    const afterOpenPath = lstatSync(absolute, { bigint: true });
    if (
      !beforeFd.isFile() ||
      !sameIdentity(beforePath, beforeFd) ||
      !sameIdentity(beforeFd, afterOpenPath)
    ) {
      throw sanitizedError(label, "changed identity while opening");
    }
    if (typeof options.onOpened === "function") {
      try {
        options.onOpened();
      } catch {
        throw sanitizedError(label, "changed during stable read");
      }
    }
    const bytes = readFileSync(handle);
    const afterFd = fstatSync(handle, { bigint: true });
    const afterPath = lstatSync(absolute, { bigint: true });
    if (
      !sameIdentity(beforeFd, afterFd) ||
      !sameIdentity(afterFd, afterPath) ||
      afterFd.size !== BigInt(bytes.length)
    ) {
      throw sanitizedError(label, "changed during stable read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw sanitizedError(label, "could not be read safely");
  } finally {
    closeSync(handle);
  }
}
