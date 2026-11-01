/**
 * Bounded count of refused upgrades that are open only to deliver their close
 * reason.
 */

/**
 * Counts sockets that were upgraded solely to be closed with a reason, so a
 * flood of refused requests cannot hold more than a fixed number open.
 */
export class ServerRefusedSockets {
  private openCount = 0;

  /**
   * Creates the counter.
   *
   * @param maximum Refused sockets allowed open at once.
   */
  constructor(private readonly maximum: number) {}

  /**
   * Reserves room for one refused socket.
   *
   * @returns True when reserved; false means answer with plain HTTP instead.
   */
  tryAcquire(): boolean {
    if (this.openCount >= this.maximum) return false;
    this.openCount += 1;
    return true;
  }

  /** Frees the room of one refused socket after it closed or failed to upgrade. */
  release(): void {
    this.openCount = Math.max(0, this.openCount - 1);
  }

  /**
   * Number of refused sockets open right now.
   *
   * @returns Open count.
   */
  get open(): number {
    return this.openCount;
  }
}
