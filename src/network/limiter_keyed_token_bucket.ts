/** Token bucket rate limiter per key (e.g. room entries per address). */
export class LimiterKeyedTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  /**
   * Creates a limiter whose keys each start with a full bucket.
   *
   * @param ratePerSecond Tokens added per second and key.
   * @param burst Bucket capacity per key.
   * @param nowMs Clock source in milliseconds.
   */
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /**
   * Takes tokens from a key's bucket if available.
   *
   * @param key Limit key.
   * @param amount Tokens to take.
   * @returns True when enough tokens were available.
   */
  take(key: string, amount = 1): boolean {
    const bucket = this.bucketRefilled(key);
    if (bucket.tokens < amount) return false;
    bucket.tokens -= amount;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Forgets keys whose bucket refilled completely, to bound memory. */
  prune(): void {
    for (const key of [...this.buckets.keys()]) {
      if (this.bucketRefilled(key).tokens >= this.burst) this.buckets.delete(key);
    }
  }

  /**
   * Reports how many keys are tracked.
   *
   * @returns Number of keys with a partially used bucket.
   */
  keyCount(): number {
    return this.buckets.size;
  }

  /**
   * Returns a key's bucket after adding tokens for the elapsed time.
   *
   * @param key Limit key.
   * @returns Bucket state (not yet stored for new keys).
   */
  private bucketRefilled(key: string): { tokens: number; lastRefillMs: number } {
    const now = this.nowMs();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, lastRefillMs: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.lastRefillMs) / 1000) * this.ratePerSecond);
    bucket.lastRefillMs = now;
    return bucket;
  }
}
