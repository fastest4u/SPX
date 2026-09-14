import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  prepareInternalRequestReplay,
  type InternalRequestReplayGuardOptions,
  type InternalRequestReplayInput,
  type InternalRequestReplayResult,
  type InternalRequestReplayStore,
  type PreparedInternalRequestReplay,
} from "./internal-auth.js";

export interface FileInternalRequestReplayGuardOptions extends InternalRequestReplayGuardOptions {
  cleanupBatchSize?: number;
  ledgerDir: string;
}

const replayFilePattern = /^[a-f0-9]{64}\.replay$/;
const temporaryReplayFilePattern = /^\.[a-f0-9]{64}\.[a-f0-9]{24}\.tmp$/;
const defaultMaxSkewMs = 120_000;
const defaultMaxEntries = 50_000;
const defaultCleanupBatchSize = 100;
const maximumEntryBytes = 32;

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return value;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

type ReplayPathKind = "directory" | "file";

export function isSecureReplayPathMode(mode: number, kind: ReplayPathKind): boolean {
  const permissions = mode & 0o777;
  return permissions === (kind === "directory" ? 0o700 : 0o600);
}

function assertSecureReplayPath(stats: Stats, kind: ReplayPathKind): void {
  if (process.platform === "win32") return;
  if (!isSecureReplayPathMode(stats.mode, kind)) {
    throw new Error(`replay ledger ${kind} permissions are invalid`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`replay ledger ${kind} ownership is invalid`);
  }
}

export class FileInternalRequestReplayGuard implements InternalRequestReplayStore {
  private readonly cleanupBatchSize: number;
  private readonly ledgerDir: string;
  private readonly maxEntries: number;
  private readonly maxSkewMs: number;
  private operation = Promise.resolve();

  constructor(options: FileInternalRequestReplayGuardOptions) {
    if (typeof options.ledgerDir !== "string" || options.ledgerDir.trim() === "") {
      throw new Error("replay ledger directory is invalid");
    }
    this.ledgerDir = resolve(options.ledgerDir);
    this.maxSkewMs = requirePositiveInteger(options.maxSkewMs ?? defaultMaxSkewMs, "replay guard skew");
    this.maxEntries = requirePositiveInteger(options.maxEntries ?? defaultMaxEntries, "replay guard capacity");
    this.cleanupBatchSize = requirePositiveInteger(
      options.cleanupBatchSize ?? defaultCleanupBatchSize,
      "replay guard cleanup batch size",
    );
  }

  consume(input: InternalRequestReplayInput): Promise<InternalRequestReplayResult> {
    const prepared = prepareInternalRequestReplay(input, this.maxSkewMs);
    if (!prepared.ok) return Promise.resolve(prepared);
    const result = this.operation.then(() => this.consumePrepared(prepared.value));
    this.operation = result.then(() => undefined, () => undefined);
    return result.catch(() => ({ ok: false, reason: "capacity" }));
  }

  private async consumePrepared(
    input: PreparedInternalRequestReplay,
  ): Promise<InternalRequestReplayResult> {
    await this.ensureLedgerDirectory();
    const entryPath = resolve(this.ledgerDir, `${input.fingerprint}.replay`);
    const existingExpiry = await this.readExpiry(entryPath);
    if (existingExpiry !== null) {
      if (existingExpiry > input.now.getTime()) return { ok: false, reason: "replay" };
      await this.unlinkIfPresent(entryPath);
    }

    if (await this.isAtCapacity(input.now.getTime())) {
      return { ok: false, reason: "capacity" };
    }

    const created = await this.createEntry(entryPath, input.expiresAt.getTime());
    if (created) return { ok: true };

    const racedExpiry = await this.readExpiry(entryPath);
    if (racedExpiry !== null && racedExpiry > input.now.getTime()) {
      return { ok: false, reason: "replay" };
    }
    return { ok: false, reason: "capacity" };
  }

  private async ensureLedgerDirectory(): Promise<void> {
    await mkdir(this.ledgerDir, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.ledgerDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("replay ledger directory is unavailable");
    }
    assertSecureReplayPath(stats, "directory");
  }

  private async isAtCapacity(nowMs: number): Promise<boolean> {
    let entries = 0;
    let cleaned = 0;
    let orphanTempsCleaned = 0;
    const directory = await opendir(this.ledgerDir);
    for await (const entry of directory) {
      const entryPath = resolve(this.ledgerDir, entry.name);
      if (temporaryReplayFilePattern.test(entry.name)) {
        if (
          orphanTempsCleaned < this.cleanupBatchSize
          && await this.isStaleTemporaryEntry(entryPath, nowMs)
        ) {
          await this.unlinkIfPresent(entryPath);
          orphanTempsCleaned += 1;
        }
        continue;
      }
      entries += 1;
      if (cleaned >= this.cleanupBatchSize || !replayFilePattern.test(entry.name)) continue;
      const expiry = await this.readExpiry(entryPath);
      if (expiry !== null && expiry <= nowMs) {
        await this.unlinkIfPresent(entryPath);
        entries -= 1;
        cleaned += 1;
      }
    }
    return entries >= this.maxEntries;
  }

  private async readExpiry(path: string): Promise<number | null> {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size <= 0 || stats.size > maximumEntryBytes) {
        throw new Error("replay ledger entry is invalid");
      }
      assertSecureReplayPath(stats, "file");
      const raw = await handle.readFile("utf8");
      const expiry = Number(raw.trim());
      if (!Number.isSafeInteger(expiry) || expiry <= 0) {
        throw new Error("replay ledger entry is invalid");
      }
      return expiry;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async createEntry(path: string, expiresAtMs: number): Promise<boolean> {
    const temporaryPath = resolve(
      this.ledgerDir,
      `.${basename(path, ".replay")}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let handle;
    let temporaryCreated = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("replay ledger temporary entry is invalid");
      assertSecureReplayPath(stats, "file");
      await handle.writeFile(`${expiresAtMs}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, path);
      await unlink(temporaryPath);
      temporaryCreated = false;
      await this.syncLedgerDirectory();
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close();
      if (temporaryCreated) await this.unlinkIfPresent(temporaryPath);
    }
  }

  private async isStaleTemporaryEntry(path: string, nowMs: number): Promise<boolean> {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("replay ledger temporary entry is invalid");
      assertSecureReplayPath(stats, "file");
      return stats.mtimeMs <= nowMs - this.maxSkewMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async syncLedgerDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(this.ledgerDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
