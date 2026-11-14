/** Exact sliding window for custom bytes and bounded frame bookkeeping. */
export class CustomWindow {
  private entries: { at: number; bytes: number }[] = [];
  private bytes = 0;

  /**
   * Charges accepted frames only in the half-open window (now-1000, now].
   *
   * @param bytes Payload byte count (zero-length frames cost one byte).
   * @param maximumBytes Byte budget.
   * @param maximumMessages Frame budget, bounding memory even for empty frames.
   * @param now Monotonic milliseconds, injectable in tests.
   * @returns Whether this frame fits.
   */
  take(bytes: number, maximumBytes: number, maximumMessages: number, now: number = performance.now()): boolean {
    this.expiredDrop(now);
    const charged = Math.max(1, bytes);
    if (this.bytes + charged > maximumBytes || this.entries.length >= maximumMessages) return false;
    this.entries.push({ at: now, bytes: charged });
    this.bytes += charged;
    return true;
  }

  /**
   * Returns how long until `bytes` fit the byte budget, so a reader can pause
   * exactly until older charges leave the window.
   *
   * @param bytes Byte count to fit (zero costs one byte); at most the budget.
   * @param maximumBytes Byte budget.
   * @param now Monotonic milliseconds, injectable in tests.
   * @returns Milliseconds to wait; 0 when they fit now.
   */
  delayMs(bytes: number, maximumBytes: number, now: number = performance.now()): number {
    this.expiredDrop(now);
    let excess = this.bytes + Math.max(1, bytes) - maximumBytes;
    for (const entry of this.entries) {
      if (excess <= 0) break;
      excess -= entry.bytes;
      if (excess <= 0) return entry.at + 1000 - now;
    }
    return excess > 0 ? 1000 : 0;
  }

  /**
   * Whether nothing is charged in the window any more.
   *
   * @param now Monotonic milliseconds, injectable in tests.
   * @returns True when the window is empty.
   */
  isEmpty(now: number = performance.now()): boolean {
    this.expiredDrop(now);
    return this.entries.length === 0;
  }

  /**
   * Drops charges that left the window (now-1000, now].
   *
   * @param now Monotonic milliseconds.
   */
  private expiredDrop(now: number): void {
    while (this.entries[0] !== undefined && this.entries[0].at <= now - 1000) {
      this.bytes -= this.entries.shift()?.bytes ?? 0;
    }
  }
}
