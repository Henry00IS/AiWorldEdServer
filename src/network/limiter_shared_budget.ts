/** Server-wide budget of one countable resource (e.g. locks across all rooms). */
export class LimiterSharedBudget {
  private used = 0;

  /**
   * Creates an empty budget.
   *
   * @param maximum Most units that may be in use at once.
   */
  constructor(readonly maximum: number) {}

  /**
   * Reports whether more units fit into the budget.
   *
   * @param amount Units that would be added.
   * @returns True when the budget can take them.
   */
  fits(amount: number): boolean {
    return amount <= 0 || this.used + amount <= this.maximum;
  }

  /**
   * Records units as used (the caller checked {@link fits}).
   *
   * @param amount Units taken.
   */
  consume(amount: number): void {
    this.used += amount;
  }

  /**
   * Returns units to the budget.
   *
   * @param amount Units freed.
   */
  release(amount: number): void {
    this.used = Math.max(0, this.used - amount);
  }

  /**
   * Reports the units in use.
   *
   * @returns Units in use.
   */
  inUse(): number {
    return this.used;
  }
}
