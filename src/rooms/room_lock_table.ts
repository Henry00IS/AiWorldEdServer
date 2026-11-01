/**
 * Object locks inside one room: exclusive locks on the objects a member edits
 * and shared (intent) locks on their ancestors. Single-threaded, so every
 * method is atomic.
 */
import { LimiterSharedBudget } from '../network/limiter_shared_budget.ts';
import { RoomSharedLockTable } from './room_shared_lock_table.ts';

/**
 * Lock conflict: the object id and the user currently holding it. `shared`
 * marks an id the other user only holds a shared lock on (an ancestor of
 * something they edit), so it must not be shown as held by them.
 */
export interface LockConflict {
  id: string;
  by: number;
  shared?: true;
}

/** Planned lock changes of one accepted acquire request. */
interface LockAcquirePlan {
  added: string[];
  removed: string[];
  sharedAdded: string[];
  sharedRemoved: string[];
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
  private readonly shared = new RoomSharedLockTable();

  /**
   * Creates an empty lock table with per-user and per-room limits.
   *
   * @param locksPerUserMaximum Most locks one user may hold.
   * @param locksPerRoomMaximum Most locks the whole room may hold.
   * @param locksServerBudget Lock budget shared by every room of the relay.
   */
  constructor(
    private readonly locksPerUserMaximum: number,
    private readonly locksPerRoomMaximum: number,
    private readonly locksServerBudget: LimiterSharedBudget = new LimiterSharedBudget(Number.MAX_SAFE_INTEGER),
  ) {}

  /**
   * Acquires every id or none. With `replace`, locks the user holds that are
   * not requested are released in the same step (selection replacement), for
   * both kinds. An exclusive id conflicts with any lock of another user on it;
   * a shared id conflicts only with another user's exclusive lock.
   *
   * @param user Requesting user id.
   * @param ids Object ids to lock exclusively.
   * @param replace Whether to release locks outside the request.
   * @param shared Ancestor ids to lock shared.
   * @returns Added and removed exclusive ids, or the conflicts / limit that
   *   blocked the request.
   */
  acquire(user: number, ids: readonly string[], replace: boolean, shared: readonly string[] = []): LockAcquireResult {
    const requested = new Set(ids);
    const sharedWanted = new Set(shared.filter((id) => !requested.has(id)));
    const conflicts = this.acquireConflicts(user, ids, sharedWanted);
    if (conflicts.length > 0) return { ok: false, reason: 'lock_conflict', conflicts };
    const plan = this.acquirePlan(user, requested, sharedWanted, replace);
    const delta = plan.added.length - plan.removed.length + plan.sharedAdded.length - plan.sharedRemoved.length;
    if (!this.withinLimits(this.countFor(user) + delta, delta)) return { ok: false, reason: 'lock_limit' };
    this.release(user, plan.removed);
    this.sharedRelease(user, plan.sharedRemoved);
    this.grant(user, plan.added);
    this.sharedGrant(user, plan.sharedAdded);
    return { ok: true, added: plan.added, removed: plan.removed };
  }

  /**
   * Lists the conflicts an exclusive and shared request has with other users'
   * shared and exclusive locks respectively.
   *
   * @param user User id.
   * @param ids Ids requested exclusively.
   * @param sharedIds Ids requested shared.
   * @returns Conflicts; exclusive requests blocked by a shared lock are marked
   *   `shared`.
   */
  conflictsShared(user: number, ids: readonly string[], sharedIds: Iterable<string>): LockConflict[] {
    const conflicts: LockConflict[] = [];
    for (const id of ids) {
      const by = this.shared.otherHolder(user, id);
      if (by !== undefined && this.holderByObjectId.get(id) === undefined) conflicts.push({ id, by, shared: true });
    }
    for (const id of sharedIds) {
      const holder = this.holderByObjectId.get(id);
      if (holder !== undefined && holder !== user) conflicts.push({ id, by: holder });
    }
    return conflicts;
  }

  /**
   * Lists what blocks an acquire: exclusive locks of others on the requested
   * ids, and shared locks against exclusive ones either way.
   *
   * @param user Requester.
   * @param ids Requested exclusive ids.
   * @param sharedWanted Requested shared ids that are not requested
   *   exclusively.
   * @returns Conflicts, empty when the acquire could go ahead.
   */
  acquireConflicts(user: number, ids: readonly string[], sharedWanted: Iterable<string>): LockConflict[] {
    return [...this.conflictsFor(user, ids), ...this.conflictsShared(user, ids, sharedWanted)];
  }

  /**
   * Shares ids with the user, consuming the server budget for new entries.
   *
   * @param user User id.
   * @param ids Ids to share.
   */
  sharedGrant(user: number, ids: Iterable<string>): void {
    this.locksServerBudget.consume(this.shared.grant(user, ids));
  }

  /**
   * Lists the shared locks a planned grant would add for the user.
   *
   * @param user User id.
   * @param ids Ids to share.
   * @returns Ids the user neither shares nor holds exclusively yet.
   */
  sharedMissing(user: number, ids: Iterable<string>): string[] {
    const held = this.shared.heldSet(user);
    return [...new Set(ids)].filter((id) => !held.has(id) && this.holderByObjectId.get(id) !== user);
  }

  /**
   * Works out which ids an accepted request adds and removes.
   *
   * @param user User id.
   * @param requested Exclusive ids requested.
   * @param sharedWanted Shared ids requested.
   * @param replace Whether ids outside the request are released.
   * @returns Planned changes.
   */
  private acquirePlan(
    user: number,
    requested: ReadonlySet<string>,
    sharedWanted: ReadonlySet<string>,
    replace: boolean,
  ): LockAcquirePlan {
    const held = this.heldSet(user);
    const sharedHeld = this.shared.heldSet(user);
    return {
      added: [...requested].filter((id) => !held.has(id)),
      removed: replace ? [...held].filter((id) => !requested.has(id)) : [],
      sharedAdded: [...sharedWanted].filter((id) => !sharedHeld.has(id)),
      sharedRemoved: replace ? [...sharedHeld].filter((id) => !sharedWanted.has(id)) : [],
    };
  }

  /**
   * Stops sharing ids and returns them to the server budget.
   *
   * @param user User id.
   * @param ids Ids to release, or undefined for all.
   */
  private sharedRelease(user: number, ids?: readonly string[]): void {
    this.locksServerBudget.release(this.shared.release(user, ids));
  }

  /**
   * Grants ids to the user without conflict checks (caller verified them).
   *
   * @param user User id.
   * @param ids Ids to grant.
   */
  grant(user: number, ids: readonly string[]): void {
    const held = this.heldSet(user);
    const sizeBefore = this.holderByObjectId.size;
    for (const id of ids) {
      this.holderByObjectId.set(id, user);
      held.add(id);
    }
    this.objectIdsByHolder.set(user, held);
    this.locksServerBudget.consume(this.holderByObjectId.size - sizeBefore);
  }

  /**
   * Releases the given ids (or every lock when omitted) that the user holds,
   * exclusive and shared.
   *
   * @param user User id.
   * @param ids Ids to release, or undefined for all.
   * @returns Exclusive ids that were actually released.
   */
  release(user: number, ids?: readonly string[]): string[] {
    this.sharedRelease(user, ids);
    const held = this.objectIdsByHolder.get(user);
    if (!held) return [];
    const released = (ids ?? [...held]).filter((id) => held.has(id));
    for (const id of released) {
      held.delete(id);
      this.holderByObjectId.delete(id);
    }
    if (held.size === 0) this.objectIdsByHolder.delete(user);
    this.locksServerBudget.release(released.length);
    return released;
  }

  /** Drops every lock of a closing room and returns them to the server budget. */
  releaseEverything(): void {
    this.locksServerBudget.release(this.holderByObjectId.size + this.shared.countTotal());
    this.shared.clear();
    this.holderByObjectId.clear();
    this.objectIdsByHolder.clear();
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
   * Counts the locks one user holds, exclusive and shared.
   *
   * @param user User id.
   * @returns Number of locks the user holds.
   */
  countFor(user: number): number {
    return (this.objectIdsByHolder.get(user)?.size ?? 0) + this.shared.countFor(user);
  }

  /**
   * Counts every lock in the room, exclusive and shared.
   *
   * @returns Total locks in the room.
   */
  countTotal(): number {
    return this.holderByObjectId.size + this.shared.countTotal();
  }

  /**
   * Lists every holder with the ids it holds exclusively.
   *
   * @returns Every holder with their ids, for join snapshots.
   */
  listAll(): { by: number; ids: string[] }[] {
    return [...this.objectIdsByHolder].map(([by, ids]) => ({ by, ids: [...ids] }));
  }

  /**
   * Checks a planned lock change against the per-user, per-room and server-wide
   * limits.
   *
   * @param userTotalAfter User lock count after the change.
   * @param roomDelta Change of the room lock count.
   * @returns True when every limit holds.
   */
  withinLimits(userTotalAfter: number, roomDelta: number): boolean {
    return (
      userTotalAfter <= this.locksPerUserMaximum &&
      this.countTotal() + roomDelta <= this.locksPerRoomMaximum &&
      this.locksServerBudget.fits(roomDelta)
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
