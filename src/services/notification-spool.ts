import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface NotificationSpoolEntry {
  eventKey: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  retryCount: number;
  firstFailedAt: string;
  nextRetryAt: string;
}

export interface AppendNotificationSpoolEntry {
  eventKey: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  retryCount?: number;
  firstFailedAt?: string;
  nextRetryAt?: string;
}

export type NotificationSpoolSender = (entry: NotificationSpoolEntry) => Promise<boolean> | boolean;
export interface NotificationSpoolFlushResult {
  sent: number;
  retained: number;
}

export interface NotificationSpoolOptions {
  baseDelayMs?: number;
  maxAttempts?: number;
}

interface NotificationSpoolOutcome {
  replacement?: NotificationSpoolEntry;
}

function entryKey(entry: NotificationSpoolEntry): string {
  return JSON.stringify(entry);
}

export class NotificationSpool {
  private readonly baseDelayMs: number;
  private readonly maxAttempts: number;
  private fileQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, options: NotificationSpoolOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  }

  async append(entry: AppendNotificationSpoolEntry): Promise<void> {
    await this.withFileLock(() => this.appendUnlocked(entry));
  }

  async readAll(): Promise<NotificationSpoolEntry[]> {
    return this.withFileLock(() => this.readAllUnlocked());
  }

  async rewrite(entries: NotificationSpoolEntry[]): Promise<void> {
    await this.withFileLock(() => this.rewriteUnlocked(entries));
  }

  async flush(sender: NotificationSpoolSender, now = new Date()): Promise<NotificationSpoolFlushResult> {
    const nowMs = now.getTime();
    const { due, retained: futureRetained } = await this.withFileLock(async () => {
      const entries = await this.readAllUnlocked();
      const dueEntries: NotificationSpoolEntry[] = [];
      const retainedEntries: NotificationSpoolEntry[] = [];
      for (const entry of entries) {
        if (Date.parse(entry.nextRetryAt) > nowMs) retainedEntries.push(entry);
        else dueEntries.push(entry);
      }
      return { due: dueEntries, retained: retainedEntries.length };
    });

    const outcomes = new Map<string, NotificationSpoolOutcome[]>();
    let failedCount = 0;
    let sentCount = 0;

    for (const entry of due) {
      let sent = false;
      try {
        sent = await sender(entry);
      } catch {
        sent = false;
      }

      if (sent) {
        sentCount += 1;
      } else {
        const retryCount = entry.retryCount + 1;
        if (retryCount < this.maxAttempts) {
          failedCount += 1;
          this.addOutcome(outcomes, entry, {
            replacement: {
              ...entry,
              retryCount,
              nextRetryAt: new Date(nowMs + this.baseDelayMs).toISOString(),
            },
          });
        } else {
          this.addOutcome(outcomes, entry, {});
        }
        continue;
      }

      this.addOutcome(outcomes, entry, {});
    }

    if (due.length > 0) {
      await this.withFileLock(async () => {
        const currentEntries = await this.readAllUnlocked();
        const retainedEntries: NotificationSpoolEntry[] = [];

        for (const entry of currentEntries) {
          const queue = outcomes.get(entryKey(entry));
          const outcome = queue?.shift();
          if (!outcome) {
            retainedEntries.push(entry);
            continue;
          }
          if (outcome.replacement) {
            retainedEntries.push(outcome.replacement);
          }
        }

        await this.rewriteUnlocked(retainedEntries);
      });
    }

    return { sent: sentCount, retained: futureRetained + failedCount };
  }

  private addOutcome(
    outcomes: Map<string, NotificationSpoolOutcome[]>,
    entry: NotificationSpoolEntry,
    outcome: NotificationSpoolOutcome,
  ): void {
    const key = entryKey(entry);
    const queue = outcomes.get(key);
    if (queue) {
      queue.push(outcome);
    } else {
      outcomes.set(key, [outcome]);
    }
  }

  private async appendUnlocked(entry: AppendNotificationSpoolEntry): Promise<void> {
    await this.ensureParentDir();
    const now = new Date().toISOString();
    const retained: NotificationSpoolEntry = {
      eventKey: entry.eventKey,
      url: entry.url,
      headers: entry.headers,
      body: entry.body,
      retryCount: entry.retryCount ?? 0,
      firstFailedAt: entry.firstFailedAt ?? now,
      nextRetryAt: entry.nextRetryAt ?? now,
    };
    await appendFile(this.filePath, `${JSON.stringify(retained)}\n`, "utf8");
  }

  private async readAllUnlocked(): Promise<NotificationSpoolEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as NotificationSpoolEntry);
  }

  private async rewriteUnlocked(entries: NotificationSpoolEntry[]): Promise<void> {
    await this.ensureParentDir();
    const content =
      entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, this.filePath);
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.fileQueue;
    let release!: () => void;
    this.fileQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
