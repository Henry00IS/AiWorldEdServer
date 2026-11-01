/** Edit validation against locks and relay to the other members. */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage, EditOperation, VerifyDenial } from '../shared/protocol_definitions.ts';
import { sessionSyncedRoom } from './handler_lock.ts';
import { verifyAsk, verifyNeeded, type VerifyClaim } from './handler_verify.ts';

type EditMessage = Extract<ClientMessage, { t: 'edit' }>;

/** Lock effects of an accepted edit. */
interface EditLockPlan {
  created: string[];
  deleted: string[];
  shared: string[];
}

/** Rejection of an edit. */
interface EditRejection {
  reason: 'not_locked' | 'lock_conflict' | 'lock_limit' | 'lock_unverified';
  ids: string[];
}

/**
 * Accepts an edit when the sender holds every lock it needs, then queues it for
 * every other member (coalesced per recipient) and applies lock effects. When a
 * member's parent chains would give it shared locks it does not have yet, the
 * room owner must confirm the chains first.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Edit batch.
 */
export function handlerEdit(core: ServerCore, session: ConnectionSession, message: EditMessage): void {
  const room = sessionSyncedRoom(session, undefined);
  if (!room) return;
  const plan = editPlan(room, session, message);
  if (plan === null) return;
  if (!verifyNeeded(room, session, plan.shared)) return editAccept(room, session, message, plan);
  const claim = editClaim(message.ops);
  if (claim === null) return editReject(session, message.seq, { reason: 'lock_unverified', ids: [] }, 'invalid');
  verifyAsk(core, room, session, claim, (outcome) => {
    if (outcome !== 'ok') return editReject(session, message.seq, { reason: 'lock_unverified', ids: [] }, outcome);
    if (session.room !== room || !session.synced) return;
    const recheckedPlan = editPlan(room, session, message);
    if (recheckedPlan !== null) editAccept(room, session, message, recheckedPlan);
  });
}

/**
 * Checks an edit against the locks and refuses it when it does not pass.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @returns Lock effects, or null when the edit was refused.
 */
function editPlan(room: Room, session: ConnectionSession, message: EditMessage): EditLockPlan | null {
  const plan: EditLockPlan = { created: [], deleted: [], shared: [] };
  const rejection = editLockCheck(room, session.user, message.ops, plan);
  if (rejection === null) return plan;
  editReject(session, message.seq, rejection, null);
  return null;
}

/**
 * Relays an accepted edit and applies its lock effects.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @param plan Lock effects.
 */
function editAccept(room: Room, session: ConnectionSession, message: EditMessage, plan: EditLockPlan): void {
  editRelay(room, session, message);
  room.locks.grant(session.user, plan.created);
  room.locks.sharedGrant(session.user, plan.shared);
  const released = room.locks.release(session.user, plan.deleted);
  roomBroadcastLocks(room, session, plan.created, released);
}

/**
 * Tells the sender its edit was refused.
 *
 * @param session Sender.
 * @param seq Sequence number of the edit.
 * @param rejection Reason and ids.
 * @param why Why the owner did not confirm, for `lock_unverified`.
 */
function editReject(session: ConnectionSession, seq: number, rejection: EditRejection, why: VerifyDenial | null): void {
  sessionSend(session, {
    t: 'edit.rejected',
    seq,
    reason: rejection.reason,
    ids: rejection.ids.slice(0, 64),
    ...(why === null ? {} : { why }),
  });
}

/**
 * Builds the owner query for the parent chains of an edit: each chain's first
 * id must exist and the rest must be its ancestors. A chain whose parent is
 * created earlier in the same batch must continue with that create's own chain,
 * which is checked here without asking the owner.
 *
 * @param operations Operations of the batch.
 * @returns Claim, or null when a chain contradicts the batch itself.
 */
export function editClaim(operations: readonly EditOperation[]): VerifyClaim | null {
  const chainOfCreated = new Map<string, readonly string[]>();
  const heads = new Set<string>();
  const ancestors = new Set<string>();
  for (const operation of operations) {
    const chain = operation.k === 'create' || operation.k === 'reparent' ? (operation.p ?? []) : [];
    const [head, ...rest] = chain;
    if (head !== undefined && chainOfCreated.has(head)) {
      if (!editChainSame(rest, chainOfCreated.get(head) ?? [])) return null;
    } else if (head !== undefined) {
      heads.add(head);
      rest.forEach((id) => ancestors.add(id));
    }
    if (operation.k === 'create') operation.ids.forEach((id) => chainOfCreated.set(id, chain));
  }
  return { ids: [...heads], anc: [...ancestors] };
}

/**
 * Compares two parent chains.
 *
 * @param left Chain.
 * @param right Chain.
 * @returns True when both list the same ids in the same order.
 */
function editChainSame(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Checks every operation in order. Ids created earlier in the same batch count
 * as held.
 *
 * @param room Room.
 * @param user Sender.
 * @param operations Operations of the batch.
 * @param plan Filled with created, deleted and newly shared ids.
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
  plan.created.push(...[...createdInBatch].filter((id) => room.locks.holderOf(id) !== user));
  plan.shared = room.locks.sharedMissing(
    user,
    plan.shared.filter((id) => !createdInBatch.has(id)),
  );
  const added = plan.created.length + plan.shared.length;
  if (!room.locks.withinLimits(room.locks.countFor(user) + added, added)) return { reason: 'lock_limit', ids: [] };
  return null;
}

/**
 * Checks one operation: its target ids and, for creates and reparents, the new
 * parent chain.
 *
 * @param room Room.
 * @param user Sender.
 * @param operation Operation.
 * @param createdInBatch Ids created earlier in the batch.
 * @param plan Collects the parent chain ids to share.
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
      : editCheckLocked(room, user, operation.ids, createdInBatch);
  if (rejection || operation.p === undefined || (operation.k !== 'create' && operation.k !== 'reparent'))
    return rejection;
  return editCheckParents(room, user, operation.p, createdInBatch, plan);
}

/**
 * Refuses moving or creating an object inside a container another member
 * exclusively holds (directly or further up the chain).
 *
 * @param room Room.
 * @param user Sender.
 * @param chain New parent chain, parent first.
 * @param createdInBatch Ids created earlier in the batch.
 * @param plan Collects the chain ids to share.
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
 * New ids must not be locked or shared by anybody else; they become locked by
 * the creator.
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
 * Every id must be locked by the sender (or created earlier in the batch).
 *
 * @param room Room.
 * @param user Sender.
 * @param ids Target ids.
 * @param createdInBatch Ids created earlier in the batch.
 * @returns Rejection or null.
 */
function editCheckLocked(
  room: Room,
  user: number,
  ids: readonly string[],
  createdInBatch: Set<string>,
): EditRejection | null {
  const missing = room.locks.missingFor(user, ids).filter((id) => !createdInBatch.has(id));
  return missing.length > 0 ? { reason: 'not_locked', ids: missing } : null;
}

/**
 * Serializes the edit entry once and queues it for each other member. Edits
 * from the owner are skipped for members whose snapshot has not begun yet,
 * because the snapshot will already contain them.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 */
function editRelay(room: Room, session: ConnectionSession, message: EditMessage): void {
  const entry = JSON.stringify({ from: session.user, seq: message.seq, ops: message.ops });
  const fromOwner = session === room.owner;
  for (const member of room.members.values()) {
    if (member === session || member.closed) continue;
    if (fromOwner && member.awaitingSnapshotBegin) continue;
    member.outbound.pushEdit(entry);
  }
}
