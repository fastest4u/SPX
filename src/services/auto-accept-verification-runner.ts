import type { ApiClient } from "./api-client.js";
import { verifyAutoAcceptJob, type AutoAcceptVerificationJob, type AutoAcceptVerificationOutcome } from "./auto-accept-verifier.js";
import {
  createAutoAcceptVerificationIntent, updateAutoAcceptVerificationResponse,
  listAutoAcceptVerificationJobs, claimAutoAcceptVerificationJob,
  rescheduleAutoAcceptVerificationJob, settleAutoAcceptVerificationJob,
  acknowledgeAutoAcceptVerificationNotification, type VerificationQueueRecord,
  importHistoricalAutoAcceptVerifications,
  reuseAutoAcceptVerificationEvidence,
} from "../repositories/auto-accept-verification-repository.js";
import { logger } from "../utils/logger.js";

export function verificationHoldCount(record: VerificationQueueRecord): number {
  const proven = record.job.discovery?.verifiedRequestIds?.length ?? 0;
  const discoveryHold = record.discoveryPending ? Math.max(1,
    (record.job.discovery?.expectedAcceptedCount ?? 1) - proven,
    (record.job.reservationCount ?? 1) - proven) : 0;
  return Math.max(record.unresolvedRequestIds.length, discoveryHold);
}

interface VerificationHooks {
  canRun: () => boolean | Promise<boolean>;
  hasUnresolvedPreparation?: (bookingId: number, requestId?: number) => boolean;
  onHold: (record: VerificationQueueRecord) => void;
  onSettled: (record: VerificationQueueRecord, acceptedIds: number[], failedIds: number[]) => void | Promise<void>;
  publish: (outcome: AutoAcceptVerificationOutcome) => Promise<boolean>;
}

/** One runner per team worker; persisted leases make overlapping recovery harmless. */
export class AutoAcceptVerificationRunner {
  private records = new Map<string, VerificationQueueRecord>();
  private active = new Map<string, Promise<void>>();
  private activeBookings = new Map<number, Promise<void>>();
  private queued = new Map<string, number>();
  private restorePromise?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private background = false;
  private runningDue = false;

  constructor(
    readonly teamId: number,
    private readonly apiClient: ApiClient,
    private readonly hooks: VerificationHooks,
    private readonly options: { retryDelayMs?: number; jitter?: () => number } = {},
  ) {}

  restore(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = listAutoAcceptVerificationJobs(this.teamId).then(records => {
        for (const record of records) this.remember(record);
      }).catch(error => { this.restorePromise = undefined; throw error; });
    }
    return this.restorePromise;
  }

  private remember(record: VerificationQueueRecord): void {
    this.records.set(record.job.traceId, record);
    this.hooks.onHold(record);
  }

  /** Restore admission protection after a lost intent-write acknowledgement. */
  adopt(record: VerificationQueueRecord): void {
    if (record.job.teamId !== this.teamId) throw new Error("Verification record scope mismatch");
    this.remember(record);
  }

  hasPending(bookingId: number, requestId?: number): boolean {
    if (this.hooks.hasUnresolvedPreparation?.(bookingId, requestId)) return true;
    for (const record of this.records.values()) {
      if (record.job.bookingId !== bookingId || verificationHoldCount(record) === 0) continue;
      if (requestId === undefined || record.job.acceptAll || record.unresolvedRequestIds.includes(requestId)) return true;
    }
    return false;
  }

  async prepare(job: AutoAcceptVerificationJob, onPersisted?: () => void): Promise<boolean> {
    await this.restore();
    if (this.stopped || !(await this.hooks.canRun())) throw new Error("Verification worker is paused or no longer owns its team");
    const { created, record } = await createAutoAcceptVerificationIntent(job);
    onPersisted?.();
    this.remember(record);
    return created;
  }

  async submitted(job: AutoAcceptVerificationJob): Promise<void> {
    const previous = this.records.get(job.traceId);
    if (previous) this.remember({ ...previous, job });
    if (!(await updateAutoAcceptVerificationResponse(job))) throw new Error("Verification intent response was not persisted");
    // The intent already protects dedupe/quota. Claim reads the authoritative response.
    this.launch(job.traceId);
  }

  async start(): Promise<void> {
    // Import legacy unresolved rows once when an actual team worker starts.
    // Ordinary per-booking submissions never run this scan.
    await importHistoricalAutoAcceptVerifications(this.teamId);
    await this.restore();
    this.background = true;
    await this.runDue();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || !this.background || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDue().catch(error => {
        logger.warn("auto-accept-verification-recovery-failed", { teamId: this.teamId, error: String(error) });
      }).finally(() => this.schedule());
    }, 1_000);
    this.timer.unref();
  }

  async runDue(now = Date.now()): Promise<void> {
    if (this.stopped || this.runningDue || this.active.size >= 2) return;
    this.runningDue = true;
    try {
      if (!(await this.hooks.canRun())) return;
      await this.restore();
      const capacity = 2 - this.active.size;
      if (this.stopped || capacity <= 0) return;
      const jobs = await listAutoAcceptVerificationJobs(this.teamId, { dueAt: now, limit: capacity });
      for (const record of jobs) {
        if (this.active.size >= 2) break;
        this.launch(record.job.traceId, now, record.job.bookingId);
      }
    } finally { this.runningDue = false; }
  }

  private launch(traceId: string, now = Date.now(), bookingId = this.records.get(traceId)?.job.bookingId): void {
    if (this.stopped || this.active.has(traceId)) return;
    if (this.active.size >= 2) { this.queued.set(traceId, now); return; }
    const previous = bookingId === undefined ? undefined : this.activeBookings.get(bookingId);
    // A sibling must see the first trace's committed evidence before deciding
    // to read again. Claim only after waiting, with a fresh lease clock.
    const work = previous ? previous.then(() => this.process(traceId, Date.now())) : this.process(traceId, now);
    const task = work.catch(error => {
      logger.warn("auto-accept-verification-retry-pending", { teamId: this.teamId, traceId, error: String(error) });
    }).finally(() => {
      this.active.delete(traceId);
      if (bookingId !== undefined && this.activeBookings.get(bookingId) === task) this.activeBookings.delete(bookingId);
      const next = this.queued.entries().next().value;
      if (next) { this.queued.delete(next[0]); this.launch(next[0], Date.now()); }
    });
    this.active.set(traceId, task);
    if (bookingId !== undefined) this.activeBookings.set(bookingId, task);
  }

  private nextAttempt(attempt: number): number {
    const delay = Math.min(300_000, (this.options.retryDelayMs ?? 5_000) * 2 ** Math.min(attempt, 6));
    return Math.max(Date.now() + delay + Math.floor((this.options.jitter?.() ?? Math.random()) * delay * 0.2),
      this.apiClient.getRateLimitRetryAt?.() ?? 0);
  }

  private async process(traceId: string, now: number): Promise<void> {
    if (this.stopped || !(await this.hooks.canRun())) return;
    const record = await claimAutoAcceptVerificationJob(this.teamId, traceId, { now, leaseMs: 300_000 });
    if (!record?.leaseToken) return;
    this.remember(record);
    try {
      if (this.stopped || !(await this.hooks.canRun())) return;
      let updated = await reuseAutoAcceptVerificationEvidence(this.teamId, traceId, record.leaseToken);
      if (!updated) return;
      this.records.set(traceId, updated);
      if (updated.unresolvedRequestIds.length !== record.unresolvedRequestIds.length) {
        await this.hooks.onSettled(updated, [], []);
      }
      if (this.stopped || !(await this.hooks.canRun())) return;
      if (verificationHoldCount(updated) > 0) {
        const job = updated.job.discovery ? updated.job : { ...updated.job, requestIds: updated.unresolvedRequestIds };
        const settledRequestIds = updated.settledRequestIds;
        const read = () => verifyAutoAcceptJob(this.apiClient, job, {
          skipAmbiguousRecheck: true, settledRequestIds,
        });
        const outcome = this.apiClient.withVerificationPriority
          ? await this.apiClient.withVerificationPriority(read, async () => !this.stopped
            && Date.now() < (record.leaseUntil ?? 0) && await this.hooks.canRun() && !this.stopped)
          : await read();
        if (this.stopped || !(await this.hooks.canRun())) return;
        const result = await settleAutoAcceptVerificationJob(this.teamId, traceId, record.leaseToken, outcome,
          { nextAttemptAt: this.nextAttempt(record.attemptCount) });
        if (!result.applied || !result.record) return;
        updated = result.record;
        this.records.set(traceId, updated);
        await this.hooks.onSettled(updated, result.newlyAcceptedRequestIds, result.newlyFailedRequestIds);
      }
      for (const notification of updated.notifications) {
        if (this.stopped || !(await this.hooks.canRun())) return;
        if (!(await this.hooks.publish(notification.outcome))) break;
        await acknowledgeAutoAcceptVerificationNotification(this.teamId, traceId, notification.id);
      }
    } finally {
      // If settlement released the lease this is a fenced no-op. DB errors leave
      // the persisted lease recoverable, without ever releasing the quota hold.
      await rescheduleAutoAcceptVerificationJob(this.teamId, traceId, record.leaseToken,
        this.nextAttempt(record.attemptCount));
      const latest = this.records.get(traceId);
      if (latest && verificationHoldCount(latest) === 0) this.records.delete(traceId);
    }
  }

  /** Wait for active reads only; delayed durable retries are intentionally not busy. */
  async idle(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { while (this.active.size > 0) await Promise.all([...this.active.values()]); })(),
        new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Verification reads did not drain")), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queued.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.idle(5_000).catch(() => undefined);
  }
}
