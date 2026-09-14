export type OcrAuthAction = "status" | "start" | "complete" | "logout";
export type OcrAuthLimitScope = "actor" | "ip";

export interface OcrAuthRateLimitPolicy {
  readonly actorLimit: number;
  readonly ipLimit: number;
  readonly windowMs: number;
}

export const OCR_AUTH_RATE_LIMIT_POLICIES: Readonly<Record<
  OcrAuthAction,
  OcrAuthRateLimitPolicy
>> = Object.freeze({
  status: Object.freeze({ actorLimit: 60, ipLimit: 120, windowMs: 60_000 }),
  start: Object.freeze({ actorLimit: 3, ipLimit: 10, windowMs: 15 * 60_000 }),
  complete: Object.freeze({ actorLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 }),
  logout: Object.freeze({ actorLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 }),
});

export interface OcrAuthRateLimitResult {
  allowed: boolean;
  limitingScope: OcrAuthLimitScope | null;
  resetAt: number;
  retryAfterMs: number;
  shouldAudit: boolean;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface CreateOcrAuthRateLimiterOptions {
  now?: () => number;
  maxBuckets?: number;
  cleanupIntervalMs?: number;
}

const DEFAULT_MAX_BUCKETS = 50_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export function createOcrAuthRateLimiter(options: CreateOcrAuthRateLimiterOptions = {}) {
  const now = options.now ?? Date.now;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  if (!Number.isInteger(maxBuckets) || maxBuckets < 2) {
    throw new Error("maxBuckets must be an integer of at least 2");
  }
  if (!Number.isInteger(cleanupIntervalMs) || cleanupIntervalMs < 1) {
    throw new Error("cleanupIntervalMs must be a positive integer");
  }

  const buckets = new Map<string, RateLimitBucket>();
  const auditedDenials = new Map<string, number>();
  let nextCleanupAt = 0;

  function cleanupExpired(timestamp: number): void {
    if (timestamp < nextCleanupAt && buckets.size < maxBuckets) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
    for (const [key, resetAt] of auditedDenials) {
      if (resetAt <= timestamp) auditedDenials.delete(key);
    }
    nextCleanupAt = timestamp + cleanupIntervalMs;
  }

  function currentBucket(key: string, timestamp: number): RateLimitBucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    if (bucket.resetAt <= timestamp) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  function markDenialForAudit(key: string, resetAt: number, timestamp: number): boolean {
    const existingResetAt = auditedDenials.get(key);
    if (existingResetAt !== undefined && existingResetAt > timestamp) return false;
    if (!auditedDenials.has(key) && auditedDenials.size >= maxBuckets) return false;
    auditedDenials.set(key, resetAt);
    return true;
  }

  function consume(input: {
    action: OcrAuthAction;
    actorUserId: number;
    clientIp: string;
  }): OcrAuthRateLimitResult {
    if (!Number.isInteger(input.actorUserId) || input.actorUserId < 1) {
      throw new Error("actorUserId must be a positive integer");
    }
    const clientIp = input.clientIp.trim();
    if (!clientIp) throw new Error("clientIp must not be empty");

    const timestamp = now();
    const policy = OCR_AUTH_RATE_LIMIT_POLICIES[input.action];
    cleanupExpired(timestamp);

    const actorKey = `${input.action}:actor:${input.actorUserId}`;
    const ipKey = `${input.action}:ip:${clientIp}`;
    const actorBucket = currentBucket(actorKey, timestamp);
    const ipBucket = currentBucket(ipKey, timestamp);
    const actorDenied = actorBucket !== undefined && actorBucket.count >= policy.actorLimit;
    const ipDenied = ipBucket !== undefined && ipBucket.count >= policy.ipLimit;

    if (actorDenied || ipDenied) {
      const actorResetAt = actorDenied ? actorBucket.resetAt : 0;
      const ipResetAt = ipDenied ? ipBucket.resetAt : 0;
      const limitingScope: OcrAuthLimitScope = ipResetAt > actorResetAt ? "ip" : "actor";
      const resetAt = Math.max(actorResetAt, ipResetAt);
      const auditIdentity = limitingScope === "actor" ? input.actorUserId : clientIp;
      return {
        allowed: false,
        limitingScope,
        resetAt,
        retryAfterMs: Math.max(0, resetAt - timestamp),
        shouldAudit: markDenialForAudit(
          `${input.action}:${limitingScope}:${auditIdentity}`,
          resetAt,
          timestamp,
        ),
      };
    }

    const newBucketCount = Number(actorBucket === undefined) + Number(ipBucket === undefined);
    if (buckets.size + newBucketCount > maxBuckets) {
      const resetAt = Math.min(...[...buckets.values()].map((bucket) => bucket.resetAt));
      return {
        allowed: false,
        limitingScope: "ip",
        resetAt,
        retryAfterMs: Math.max(0, resetAt - timestamp),
        shouldAudit: markDenialForAudit(
          `${input.action}:ip:${clientIp}`,
          resetAt,
          timestamp,
        ),
      };
    }

    const resetAt = timestamp + policy.windowMs;
    if (actorBucket) actorBucket.count += 1;
    else buckets.set(actorKey, { count: 1, resetAt });
    if (ipBucket) ipBucket.count += 1;
    else buckets.set(ipKey, { count: 1, resetAt });

    return {
      allowed: true,
      limitingScope: null,
      resetAt: Math.max(actorBucket?.resetAt ?? resetAt, ipBucket?.resetAt ?? resetAt),
      retryAfterMs: 0,
      shouldAudit: false,
    };
  }

  return {
    consume,
    bucketCount: (): number => buckets.size,
  };
}
