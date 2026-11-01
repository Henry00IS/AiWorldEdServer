/** Counts concurrent resources (connections, rooms) per key with a cap. */
export class LimiterKeyCounter {
  private readonly counts = new Map<string, number>();

  /** @param maximumPerKey Largest count allowed per key. */
  constructor(private readonly maximumPerKey: number) {}

  /**
   * Increments the key when below the cap.
   *
   * @param key Limit key.
   * @returns True when incremented.
   */
  tryAcquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.maximumPerKey) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  /**
   * Decrements the key and forgets it at zero.
   *
   * @param key Limit key.
   */
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  /**
   * @param key Limit key.
   * @returns Current count.
   */
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** @returns Number of tracked keys. */
  keyCount(): number {
    return this.counts.size;
  }
}
