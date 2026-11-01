/** Fixed-window failure counter per key (e.g. wrong passwords per minute). */
export class LimiterFailureWindow {
  private readonly windows = new Map<string, { startMs: number; failures: number }>();

  /**
   * @param maximumFailures Failures allowed per window.
   * @param windowMs Window length in milliseconds.
   * @param nowMs Clock source in milliseconds.
   */
  constructor(
    private readonly maximumFailures: number,
    private readonly windowMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * @param key Limit key.
   * @returns True when the key has exhausted its failures in the current
   *   window.
   */
  isBlocked(key: string): boolean {
    const window = this.windowCurrent(key);
    return window !== null && window.failures >= this.maximumFailures;
  }

  /**
   * Records one failure.
   *
   * @param key Limit key.
   */
  recordFailure(key: string): void {
    const window = this.windowCurrent(key) ?? { startMs: this.nowMs(), failures: 0 };
    window.failures++;
    this.windows.set(key, window);
  }

  /** Drops expired windows to bound memory. */
  prune(): void {
    for (const key of [...this.windows.keys()]) this.windowCurrent(key);
  }

  /**
   * @param key Limit key.
   * @returns The live window, or null after removing an expired one.
   */
  private windowCurrent(key: string): { startMs: number; failures: number } | null {
    const window = this.windows.get(key);
    if (!window) return null;
    if (this.nowMs() - window.startMs < this.windowMs) return window;
    this.windows.delete(key);
    return null;
  }
}
