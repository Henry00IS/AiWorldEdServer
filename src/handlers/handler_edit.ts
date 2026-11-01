/** Edit validation against locks and relay to the other members. */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage, EditOperation } from '../shared/protocol_definitions.ts';
import { sessionSyncedRoom } from './handler_lock.ts';

type EditMessage = Extract<ClientMessage, { t: 'edit' }>;

/** Lock effects of an accepted edit. */
interface EditLockPlan {
  created: string[];
  deleted: string[];
}

/** Rejection of an edit. */
interface EditRejection {
  reason: 'not_locked' | 'lock_conflict' | 'lock_limit';
  ids: string[];
}

/**
 * Accepts an edit when the sender holds every lock it needs, then queues it for
 * every other member (coalesced per recipient) and applies lock effects.
 *
 * @param _core Relay core.
 * @param session Sender.
 * @param message Edit batch.
 */
export function handlerEdit(_core: ServerCore, session: ConnectionSession, message: EditMessage): void {
  const room = sessionSyncedRoom(session, undefined);
  if (!room) return;
  const plan: EditLockPlan = { created: [], deleted: [] };
  const rejection = editLockCheck(room, session.user, message.ops, plan);
  if (rejection)
    return sessionSend(session, {
      t: 'edit.rejected',
      seq: message.seq,
      reason: rejection.reason,
      ids: rejection.ids.slice(0, 64),
    });
  editRelay(room, session, message);
  room.locks.grant(session.user, plan.created);
  const released = room.locks.release(session.user, plan.deleted);
  roomBroadcastLocks(room, session, plan.created, released);
}

/**
 * Checks every operation in order. Ids created earlier in the same batch count
 * as held.
 *
 * @param room Room.
 * @param user Sender.
 * @param operations Operations of the batch.
 * @param plan Filled with created and deleted ids.
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
    const rejection =
      operation.k === 'create'
        ? editCheckCreate(room, user, operation.ids, createdInBatch)
        : editCheckLocked(room, user, operation.ids, createdInBatch);
    if (rejection) return rejection;
    if (operation.k === 'delete') plan.deleted.push(...operation.ids);
  }
  plan.created.push(...[...createdInBatch].filter((id) => room.locks.holderOf(id) !== user));
  if (!room.locks.withinLimits(room.locks.countFor(user) + plan.created.length, plan.created.length))
    return { reason: 'lock_limit', ids: [] };
  return null;
}

/**
 * New ids must not be locked by anybody else; they become locked by the
 * creator.
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
  const conflicts = room.locks.conflictsFor(user, ids);
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
