/** Token bucket rate limiter. */
export class LimiterTokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  /**
   * Creates a full token bucket.
   *
   * @param ratePerSecond Tokens added per second.
   * @param burst Bucket capacity.
   * @param nowMs Clock source in milliseconds.
   */
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.lastRefillMs = nowMs();
  }

  /**
   * Takes tokens if available.
   *
   * @param amount Tokens to take.
   * @returns True when enough tokens were available.
   */
  take(amount = 1): boolean {
    this.refill();
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }

  /**
   * Returns tokens, for traffic the relay asked for itself.
   *
   * @param amount Tokens to return.
   */
  give(amount = 1): void {
    this.refill();
    this.tokens = Math.min(this.burst, this.tokens + amount);
  }

  /** Adds tokens for the elapsed time, capped at the burst size. */
  private refill(): void {
    const now = this.nowMs();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefillMs) / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
  }
}
