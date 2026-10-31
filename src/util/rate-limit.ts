export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Small in-memory fixed-window limiter. It protects a single server instance;
 * the Pagey API has its own authoritative account and request limits.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    maxKeys = 20_000,
  ) {
    this.maxKeys = maxKeys;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    if (this.buckets.size > this.maxKeys) this.prune(now);
    return {
      allowed: bucket.count <= this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterSeconds,
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // If every bucket is still active, drop the oldest entries.
    if (this.buckets.size > this.maxKeys) {
      const excess = this.buckets.size - this.maxKeys;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++removed >= excess) break;
      }
    }
  }
}
