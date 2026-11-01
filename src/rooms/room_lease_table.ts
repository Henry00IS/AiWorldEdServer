/**
 * Edit leases inside one room: at most one running operation per member, with a
 * deadline that renewals and edits push out, a cap on how long renewals alone
 * keep it alive and an absolute cap per operation. Times come from the relay's
 * monotonic clock only.
 */

/** Timing limits of leases. */
export interface RoomLeaseTimings {
  /** Lifetime without a renewal or an edit. */
  leaseMs: number;
  /** Longest a lease lives on renewals alone. */
  idleMaximumMs: number;
  /** Longest one operation may hold its lease. */
  totalMaximumMs: number;
}

/** The running operation of one member. */
export interface RoomLease {
  readonly id: number;
  readonly startedMs: number;
  progressMs: number;
  deadlineMs: number;
}

/** Default timings, matching the relay defaults. */
export const ROOM_LEASE_TIMINGS_DEFAULT: RoomLeaseTimings = {
  leaseMs: 5000,
  idleMaximumMs: 60_000,
  totalMaximumMs: 600_000,
};

/** Per-room lease table keyed by member. */
export class RoomLeaseTable {
  private readonly leases = new Map<number, RoomLease>();
  private readonly lastIds = new Map<number, number>();

  /**
   * Creates an empty lease table.
   *
   * @param timings Lease timing limits.
   * @param nowMs Monotonic clock in milliseconds.
   */
  constructor(
    private readonly timings: RoomLeaseTimings = ROOM_LEASE_TIMINGS_DEFAULT,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /**
   * Returns the running lease of a member.
   *
   * @param user Member.
   * @returns Lease, or undefined.
   */
  of(user: number): RoomLease | undefined {
    return this.leases.get(user);
  }

  /**
   * Returns the highest lease number a member has used in this room.
   *
   * @param user Member.
   * @returns Highest lease number, 0 when none.
   */
  lastId(user: number): number {
    return this.lastIds.get(user) ?? 0;
  }

  /**
   * Starts a new lease for a member (the caller checked it may).
   *
   * @param user Member.
   * @param id Lease number.
   */
  begin(user: number, id: number): void {
    const now = this.nowMs();
    this.leases.set(user, { id, startedMs: now, progressMs: now, deadlineMs: now + this.timings.leaseMs });
    this.lastIds.set(user, Math.max(id, this.lastId(user)));
  }

  /**
   * Puts back a lease that a replace briefly emptied while the same operation
   * went on.
   *
   * @param user Member.
   * @param lease The running lease.
   */
  adopt(user: number, lease: RoomLease): void {
    this.leases.set(user, lease);
  }

  /**
   * Pushes out the deadline of a running lease without counting as progress.
   *
   * @param user Member.
   * @param id Lease number the member renews.
   * @returns True when the lease was running and matched.
   */
  renew(user: number, id: number): boolean {
    const lease = this.leases.get(user);
    if (lease === undefined || lease.id !== id) return false;
    lease.deadlineMs = this.nowMs() + this.timings.leaseMs;
    return true;
  }

  /**
   * Records an accepted edit under the running lease.
   *
   * @param user Member.
   */
  progress(user: number): void {
    const lease = this.leases.get(user);
    if (lease === undefined) return;
    const now = this.nowMs();
    lease.progressMs = now;
    lease.deadlineMs = now + this.timings.leaseMs;
  }

  /**
   * Ends the lease of a member.
   *
   * @param user Member.
   */
  end(user: number): void {
    this.leases.delete(user);
  }

  /**
   * Forgets a member entirely (it left the room).
   *
   * @param user Member.
   */
  forget(user: number): void {
    this.leases.delete(user);
    this.lastIds.delete(user);
  }

  /** Drops every lease (room closing). */
  clear(): void {
    this.leases.clear();
    this.lastIds.clear();
  }

  /**
   * Lists the members whose lease ran out: no renewal in time, renewals only
   * for too long, or the operation ran past the absolute cap.
   *
   * @returns Members with an expired lease.
   */
  expired(): number[] {
    const now = this.nowMs();
    const { idleMaximumMs, totalMaximumMs } = this.timings;
    const expired: number[] = [];
    for (const [user, lease] of this.leases) {
      if (now >= lease.deadlineMs || now - lease.progressMs >= idleMaximumMs || now - lease.startedMs >= totalMaximumMs)
        expired.push(user);
    }
    return expired;
  }

  /**
   * Counts running leases.
   *
   * @returns Number of members with a running lease.
   */
  count(): number {
    return this.leases.size;
  }
}
