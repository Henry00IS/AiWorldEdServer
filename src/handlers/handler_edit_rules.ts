/**
 * Lock rules of edits under barrier-free locking: one-shot edits need no lock
 * and are refused only where another member holds a lease; while the sender
 * runs an operation every target must belong to it.
 */
import type { Room } from '../rooms/room.ts';
import type { EditOperation } from '../shared/protocol_definitions.ts';

/** Lock effects and owner claims of an accepted edit. */
export interface EditLockPlan {
  /** Ids the batch creates. */
  created: string[];
  /** Ids the batch deletes. */
  deleted: string[];
  /** Parent chain ids the sender does not share yet (owner verifies them). */
  shared: string[];
}

/** Rejection of an edit. */
export interface EditRejection {
  reason:
    'lock_conflict' | 'lock_limit' | 'lock_unverified' | 'outside_lease' | 'lease_stale' | 'rate_limited' | 'throttled';
  ids: string[];
}

/**
 * Checks every operation in order. While the sender runs a lease, targets must
 * be inside it (ids created earlier in the batch count as inside). Otherwise
 * targets must not be leased by another member; deletes also not shared by one
 * (somebody works inside them).
 *
 * @param room Room.
 * @param user Sender.
 * @param operations Operations of the batch.
 * @param plan Filled with created, deleted and unshared chain ids.
 * @returns Null when acceptable, otherwise the rejection.
 */
export function editLockCheck(
  room: Room,
  user: number,
  operations: readonly EditOperation[],
  plan: EditLockPlan,
): EditRejection | null {
  const createdInBatch = new Set<string>();
  for (const operation of operations) {
    const rejection = editCheckOperation(room, user, operation, createdInBatch, plan);
    if (rejection) return rejection;
    if (operation.k === 'delete') plan.deleted.push(...operation.ids);
  }
  plan.created.push(...createdInBatch);
  plan.shared = room.locks.sharedMissing(
    user,
    plan.shared.filter((id) => !createdInBatch.has(id)),
  );
  return editCheckLeaseLimit(room, user, plan);
}

/**
 * Creates during a running operation join its lease (duplicate-drag), so they
 * must fit the lock limits.
 *
 * @param room Room.
 * @param user Sender.
 * @param plan Lock effects.
 * @returns Rejection or null.
 */
function editCheckLeaseLimit(room: Room, user: number, plan: EditLockPlan): EditRejection | null {
  if (room.locks.leases.of(user) === undefined || plan.created.length === 0) return null;
  const added = plan.created.length;
  return room.locks.withinLimits(room.locks.countFor(user) + added, added) ? null : { reason: 'lock_limit', ids: [] };
}

/**
 * Checks one operation: its target ids and, for creates and reparents, the new
 * parent chain.
 *
 * @param room Room.
 * @param user Sender.
 * @param operation Operation.
 * @param createdInBatch Ids created earlier in the batch.
 * @param plan Collects the parent chain ids.
 * @returns Rejection or null.
 */
function editCheckOperation(
  room: Room,
  user: number,
  operation: EditOperation,
  createdInBatch: Set<string>,
  plan: EditLockPlan,
): EditRejection | null {
  const rejection =
    operation.k === 'create'
      ? editCheckCreate(room, user, operation.ids, createdInBatch)
      : editCheckTargets(room, user, operation, createdInBatch);
  if (rejection || operation.p === undefined || (operation.k !== 'create' && operation.k !== 'reparent'))
    return rejection;
  return editCheckParents(room, user, operation.p, createdInBatch, plan);
}

/**
 * Refuses moving or creating an object inside a container another member leases
 * (directly or further up the chain).
 *
 * @param room Room.
 * @param user Sender.
 * @param chain New parent chain, parent first.
 * @param createdInBatch Ids created earlier in the batch.
 * @param plan Collects the chain ids.
 * @returns Rejection or null.
 */
function editCheckParents(
  room: Room,
  user: number,
  chain: readonly string[],
  createdInBatch: ReadonlySet<string>,
  plan: EditLockPlan,
): EditRejection | null {
  const conflicts = room.locks.conflictsFor(
    user,
    chain.filter((id) => !createdInBatch.has(id)),
  );
  if (conflicts.length > 0) return { reason: 'lock_conflict', ids: conflicts.map((conflict) => conflict.id) };
  plan.shared.push(...chain);
  return null;
}

/**
 * New ids must not be locked or shared by anybody else.
 *
 * @param room Room.
 * @param user Creator.
 * @param ids New object ids.
 * @param createdInBatch Collects created ids.
 * @returns Rejection or null.
 */
function editCheckCreate(
  room: Room,
  user: number,
  ids: readonly string[],
  createdInBatch: Set<string>,
): EditRejection | null {
  const conflicts = [...room.locks.conflictsFor(user, ids), ...room.locks.conflictsShared(user, ids, [])];
  if (conflicts.length > 0) return { reason: 'lock_conflict', ids: conflicts.map((conflict) => conflict.id) };
  for (const id of ids) createdInBatch.add(id);
  return null;
}

/**
 * Checks the targets of a change, reparent or delete against the sender's own
 * lease and other members' leases.
 *
 * @param room Room.
 * @param user Sender.
 * @param operation Operation.
 * @param createdInBatch Ids created earlier in the batch.
 * @returns Rejection or null.
 */
function editCheckTargets(
  room: Room,
  user: number,
  operation: EditOperation,
  createdInBatch: ReadonlySet<string>,
): EditRejection | null {
  const ids = operation.ids.filter((id) => !createdInBatch.has(id));
  if (room.locks.leases.of(user) !== undefined) {
    const held = room.locks.exclusiveOf(user);
    const outside = ids.filter((id) => !held.has(id));
    return outside.length > 0 ? { reason: 'outside_lease', ids: outside } : null;
  }
  const conflicts =
    operation.k === 'delete'
      ? [...room.locks.conflictsFor(user, ids), ...room.locks.conflictsShared(user, ids, [])]
      : room.locks.conflictsFor(user, ids);
  return conflicts.length > 0 ? { reason: 'lock_conflict', ids: conflicts.map((conflict) => conflict.id) } : null;
}
