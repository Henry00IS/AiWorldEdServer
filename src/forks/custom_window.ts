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
    while (this.entries[0] !== undefined && this.entries[0].at <= now - 1000) {
      this.bytes -= this.entries.shift()?.bytes ?? 0;
    }
    const charged = Math.max(1, bytes);
    if (this.bytes + charged > maximumBytes || this.entries.length >= maximumMessages) return false;
    this.entries.push({ at: now, bytes: charged });
    this.bytes += charged;
    return true;
  }
}
