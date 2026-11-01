/**
 * Exclusive object locks inside one room. Single-threaded, so every method is
 * atomic.
 */

/** Lock conflict: the object id and the user currently holding it. */
export interface LockConflict {
  id: string;
  by: number;
}

/** Outcome of an acquire request. */
export type LockAcquireResult =
  | { ok: true; added: string[]; removed: string[] }
  | { ok: false; reason: 'lock_conflict'; conflicts: LockConflict[] }
  | { ok: false; reason: 'lock_limit' };

/** Per-room lock ownership table. */
export class RoomLockTable {
  private readonly holderByObjectId = new Map<string, number>();
  private readonly objectIdsByHolder = new Map<number, Set<string>>();

  /**
   * Creates an empty lock table with per-user and per-room limits.
   *
   * @param locksPerUserMaximum Most locks one user may hold.
   * @param locksPerRoomMaximum Most locks the whole room may hold.
   */
  constructor(
    private readonly locksPerUserMaximum: number,
    private readonly locksPerRoomMaximum: number,
  ) {}

  /**
   * Acquires every id or none. With `replace`, locks the user holds that are
   * not in `ids` are released in the same step (selection replacement).
   *
   * @param user Requesting user id.
   * @param ids Object ids to lock.
   * @param replace Whether to release locks outside `ids`.
   * @returns Added and removed ids, or the conflicts / limit that blocked the
   *   request.
   */
  acquire(user: number, ids: readonly string[], replace: boolean): LockAcquireResult {
    const conflicts = this.conflictsFor(user, ids);
    if (conflicts.length > 0) return { ok: false, reason: 'lock_conflict', conflicts };
    const requested = new Set(ids);
    const held = this.heldSet(user);
    const removed = replace ? [...held].filter((id) => !requested.has(id)) : [];
    const added = [...requested].filter((id) => !held.has(id));
    if (!this.withinLimits(held.size - removed.length + added.length, added.length - removed.length))
      return { ok: false, reason: 'lock_limit' };
    this.release(user, removed);
    this.grant(user, added);
    return { ok: true, added, removed };
  }

  /**
   * Grants ids to the user without conflict checks (caller verified them).
   *
   * @param user User id.
   * @param ids Ids to grant.
   */
  grant(user: number, ids: readonly string[]): void {
    const held = this.heldSet(user);
    for (const id of ids) {
      this.holderByObjectId.set(id, user);
      held.add(id);
    }
    this.objectIdsByHolder.set(user, held);
  }

  /**
   * Releases the given ids (or every lock when omitted) that the user holds.
   *
   * @param user User id.
   * @param ids Ids to release, or undefined for all.
   * @returns Ids that were actually released.
   */
  release(user: number, ids?: readonly string[]): string[] {
    const held = this.objectIdsByHolder.get(user);
    if (!held) return [];
    const released = (ids ?? [...held]).filter((id) => held.has(id));
    for (const id of released) {
      held.delete(id);
      this.holderByObjectId.delete(id);
    }
    if (held.size === 0) this.objectIdsByHolder.delete(user);
    return released;
  }

  /**
   * Lists the requested ids that another user already holds.
   *
   * @param user User id.
   * @param ids Ids to check.
   * @returns Ids held by another user, with their holder.
   */
  conflictsFor(user: number, ids: readonly string[]): LockConflict[] {
    const conflicts: LockConflict[] = [];
    for (const id of ids) {
      const holder = this.holderByObjectId.get(id);
      if (holder !== undefined && holder !== user) conflicts.push({ id, by: holder });
    }
    return conflicts;
  }

  /**
   * Lists the ids the user does not hold.
   *
   * @param user User id.
   * @param ids Ids to check.
   * @returns Ids the user does not hold.
   */
  missingFor(user: number, ids: readonly string[]): string[] {
    return ids.filter((id) => this.holderByObjectId.get(id) !== user);
  }

  /**
   * Looks up the user holding an object lock.
   *
   * @param id Object id.
   * @returns Holder user id or undefined.
   */
  holderOf(id: string): number | undefined {
    return this.holderByObjectId.get(id);
  }

  /**
   * Counts the locks one user holds.
   *
   * @param user User id.
   * @returns Number of locks the user holds.
   */
  countFor(user: number): number {
    return this.objectIdsByHolder.get(user)?.size ?? 0;
  }

  /**
   * Counts every lock in the room.
   *
   * @returns Total locks in the room.
   */
  countTotal(): number {
    return this.holderByObjectId.size;
  }

  /**
   * Lists every holder with the ids it holds.
   *
   * @returns Every holder with their ids, for join snapshots.
   */
  listAll(): { by: number; ids: string[] }[] {
    return [...this.objectIdsByHolder].map(([by, ids]) => ({ by, ids: [...ids] }));
  }

  /**
   * Checks a planned lock change against the per-user and per-room limits.
   *
   * @param userTotalAfter User lock count after the change.
   * @param roomDelta Change of the room lock count.
   * @returns True when both limits hold.
   */
  withinLimits(userTotalAfter: number, roomDelta: number): boolean {
    return (
      userTotalAfter <= this.locksPerUserMaximum && this.holderByObjectId.size + roomDelta <= this.locksPerRoomMaximum
    );
  }

  /**
   * Returns the live lock set of a user.
   *
   * @param user User id.
   * @returns The user's live lock set (empty set when none).
   */
  private heldSet(user: number): Set<string> {
    return this.objectIdsByHolder.get(user) ?? new Set();
  }
}
