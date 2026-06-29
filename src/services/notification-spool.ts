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

export class NotificationSpool {
  constructor(private readonly filePath: string) {}

  async append(entry: AppendNotificationSpoolEntry): Promise<void> {
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

  async readAll(): Promise<NotificationSpoolEntry[]> {
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

  async rewrite(entries: NotificationSpoolEntry[]): Promise<void> {
    await this.ensureParentDir();
    const content =
      entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, this.filePath);
  }

  async flush(sender: NotificationSpoolSender, now = new Date()): Promise<NotificationSpoolFlushResult> {
    const entries = await this.readAll();
    const retained: NotificationSpoolEntry[] = [];
    let sentCount = 0;

    for (const entry of entries) {
      if (Date.parse(entry.nextRetryAt) > now.getTime()) {
        retained.push(entry);
        continue;
      }

      let sent = false;
      try {
        sent = await sender(entry);
      } catch {
        sent = false;
      }

      if (sent) {
        sentCount += 1;
      } else {
        retained.push({
          ...entry,
          retryCount: entry.retryCount + 1,
          nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
    }

    await this.rewrite(retained);
    return { sent: sentCount, retained: retained.length };
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }
}
