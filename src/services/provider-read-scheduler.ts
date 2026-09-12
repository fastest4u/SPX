export type ProviderReadPriority = "normal" | "verification";
export type ProviderReadAdmissionGuard = () => boolean | Promise<boolean>;

export class ProviderReadAdmissionError extends Error {
  constructor(cause?: unknown) {
    super("Provider read is no longer admitted", cause === undefined ? undefined : { cause });
    this.name = "ProviderReadAdmissionError";
  }
}

export interface ProviderReadSchedulerOptions {
  maxConcurrency?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface QueuedRead<T> {
  read: () => Promise<T>;
  priority: ProviderReadPriority;
  admissionGuard?: ProviderReadAdmissionGuard;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class ProviderReadScheduler {
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly verificationQueue: QueuedRead<unknown>[] = [];
  private readonly normalQueue: QueuedRead<unknown>[] = [];
  private active = 0;
  private retryAt = 0;
  private cooldownTimer: unknown | null = null;

  constructor(options: ProviderReadSchedulerOptions = {}) {
    const configuredConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = configuredConcurrency;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  getRateLimitRetryAt(): number {
    return this.retryAt > this.now() ? this.retryAt : 0;
  }

  deferFor(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    this.retryAt = Math.max(this.retryAt, this.now() + delayMs);
    this.armCooldownTimer();
  }

  schedule<T>(
    read: () => Promise<T>,
    priority: ProviderReadPriority = "normal",
    admissionGuard?: ProviderReadAdmissionGuard,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedRead<T> = { read, priority, admissionGuard, resolve, reject };
      this.enqueue(queued as QueuedRead<unknown>);
      this.drain();
    });
  }

  private enqueue(queued: QueuedRead<unknown>, front = false): void {
    const queue = queued.priority === "verification" ? this.verificationQueue : this.normalQueue;
    if (front) queue.unshift(queued);
    else queue.push(queued);
  }

  private armCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.verificationQueue.length === 0 && this.normalQueue.length === 0) return;

    const remainingMs = this.retryAt - this.now();
    if (remainingMs <= 0) {
      this.drain();
      return;
    }
    this.cooldownTimer = this.setTimer(() => {
      this.cooldownTimer = null;
      this.drain();
    }, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  }

  private drain(): void {
    if (this.retryAt > this.now()) {
      this.armCooldownTimer();
      return;
    }

    if (this.cooldownTimer !== null) {
      this.clearTimer(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    while (this.active < this.maxConcurrency) {
      const queued = this.verificationQueue.shift() ?? this.normalQueue.shift();
      if (!queued) return;

      this.active += 1;
      void Promise.resolve()
        .then(async () => {
          if (queued.admissionGuard) {
            let admitted: boolean;
            try {
              admitted = await queued.admissionGuard();
            } catch (error) {
              throw new ProviderReadAdmissionError(error);
            }
            if (!admitted) throw new ProviderReadAdmissionError();
          }
          if (this.retryAt > this.now()) return { requeue: true as const };
          return { requeue: false as const, value: await queued.read() };
        })
        .then((result) => {
          if (result.requeue) {
            this.enqueue(queued, true);
          } else {
            queued.resolve(result.value);
          }
        }, queued.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
