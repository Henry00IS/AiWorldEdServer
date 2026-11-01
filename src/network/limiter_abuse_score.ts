/**
 * Abuse scores: points for protocol misuse that decay linearly over time on the
 * relay's monotonic clock. A session keeps its own score; when it closes, what
 * is left is carried over to its address key so a reconnect loop cannot reset
 * the count.
 */

/** One decaying score. */
export class LimiterAbuseScore {
  private points = 0;
  private lastMs: number;

  /**
   * Creates a score.
   *
   * @param decayPerSecond Points that decay per second.
   * @param initial Starting points.
   * @param nowMs Monotonic clock in milliseconds.
   */
  constructor(
    private readonly decayPerSecond: number,
    initial = 0,
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    this.points = initial;
    this.lastMs = nowMs();
  }

  /**
   * Adds points after decaying the score.
   *
   * @param amount Points to add.
   * @returns Score after the addition.
   */
  add(amount: number): number {
    this.decay();
    this.points += amount;
    return this.points;
  }

  /**
   * Returns the decayed score.
   *
   * @returns Current score.
   */
  value(): number {
    this.decay();
    return this.points;
  }

  /** Applies the decay since the last look. */
  private decay(): void {
    const now = this.nowMs();
    this.points = Math.max(0, this.points - ((now - this.lastMs) / 1000) * this.decayPerSecond);
    this.lastMs = now;
  }
}

/** Scores left behind by closed sessions, per address key. */
export class LimiterAbuseCarry {
  private readonly scores = new Map<string, LimiterAbuseScore>();

  /**
   * Creates an empty carry table.
   *
   * @param decayPerSecond Points that decay per second.
   * @param keysMaximum Most address keys remembered; the oldest go first.
   * @param nowMs Monotonic clock in milliseconds.
   */
  constructor(
    private readonly decayPerSecond: number,
    private readonly keysMaximum = 100_000,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /**
   * Starts the score of a new session from what its address left behind.
   *
   * @param key Address key.
   * @param cap Highest score a new session inherits (keeps other clients behind
   *   the same address usable).
   * @returns Fresh session score.
   */
  sessionScore(key: string, cap = Number.POSITIVE_INFINITY): LimiterAbuseScore {
    const inherited = Math.min(cap, this.scores.get(key)?.value() ?? 0);
    return new LimiterAbuseScore(this.decayPerSecond, inherited, this.nowMs);
  }

  /**
   * Remembers the score of a closing session (the higher of old and new).
   *
   * @param key Address key.
   * @param score Session score.
   */
  sessionClosed(key: string, score: LimiterAbuseScore): void {
    const points = score.value();
    if (points <= (this.scores.get(key)?.value() ?? 0)) return;
    this.scores.delete(key);
    if (this.scores.size >= this.keysMaximum) this.scores.delete(this.scores.keys().next().value as string);
    this.scores.set(key, new LimiterAbuseScore(this.decayPerSecond, points, this.nowMs));
  }

  /** Forgets addresses whose score decayed to zero. */
  prune(): void {
    for (const [key, score] of this.scores) if (score.value() === 0) this.scores.delete(key);
  }

  /**
   * Counts remembered addresses.
   *
   * @returns Number of address keys with a score.
   */
  keyCount(): number {
    return this.scores.size;
  }
}
