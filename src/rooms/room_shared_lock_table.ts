/**
 * Shared (intent) locks inside one room: a member editing an object holds a
 * shared lock on each of its ancestors. Several members may share an id, but
 * nobody else may lock that id exclusively while it is shared, so a container
 * cannot be moved, deleted or regrouped while something inside it is edited.
 */

/** Per-room shared lock table. */
export class RoomSharedLockTable {
  private readonly holdersByObjectId = new Map<string, Set<number>>();
  private readonly objectIdsByHolder = new Map<number, Set<string>>();
  private entries = 0;

  /**
   * Returns the first other user sharing an id.
   *
   * @param user User asking.
   * @param id Object id.
   * @returns Another holder, or undefined when only the user (or nobody) shares
   *   it.
   */
  otherHolder(user: number, id: string): number | undefined {
    const holders = this.holdersByObjectId.get(id);
    if (holders === undefined) return undefined;
    for (const holder of holders) if (holder !== user) return holder;
    return undefined;
  }

  /**
   * Returns the ids the user shares.
   *
   * @param user User id.
   * @returns The user's live shared set (empty set when none).
   */
  heldSet(user: number): ReadonlySet<string> {
    return this.objectIdsByHolder.get(user) ?? new Set();
  }

  /**
   * Shares ids with the user.
   *
   * @param user User id.
   * @param ids Ids to share.
   * @returns Number of entries actually added.
   */
  grant(user: number, ids: Iterable<string>): number {
    const held = this.objectIdsByHolder.get(user) ?? new Set<string>();
    let added = 0;
    for (const id of ids) {
      if (held.has(id)) continue;
      held.add(id);
      const holders = this.holdersByObjectId.get(id) ?? new Set<number>();
      holders.add(user);
      this.holdersByObjectId.set(id, holders);
      added += 1;
    }
    if (held.size > 0) this.objectIdsByHolder.set(user, held);
    this.entries += added;
    return added;
  }

  /**
   * Stops sharing the given ids (or every id when omitted).
   *
   * @param user User id.
   * @param ids Ids to release, or undefined for all.
   * @returns Number of entries actually released.
   */
  release(user: number, ids?: Iterable<string>): number {
    const held = this.objectIdsByHolder.get(user);
    if (!held) return 0;
    const released = [...(ids ?? [...held])].filter((id) => held.has(id));
    for (const id of released) {
      held.delete(id);
      const holders = this.holdersByObjectId.get(id);
      holders?.delete(user);
      if (holders?.size === 0) this.holdersByObjectId.delete(id);
    }
    if (held.size === 0) this.objectIdsByHolder.delete(user);
    this.entries -= released.length;
    return released.length;
  }

  /**
   * Counts the ids one user shares.
   *
   * @param user User id.
   * @returns Shared entries of the user.
   */
  countFor(user: number): number {
    return this.objectIdsByHolder.get(user)?.size ?? 0;
  }

  /**
   * Counts every shared entry in the room.
   *
   * @returns Shared entries (one per user and id).
   */
  countTotal(): number {
    return this.entries;
  }

  /** Forgets every shared lock. */
  clear(): void {
    this.holdersByObjectId.clear();
    this.objectIdsByHolder.clear();
    this.entries = 0;
  }
}
