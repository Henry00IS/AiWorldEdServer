/** Selection lock acquire and release. */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { verifyAsk, verifyNeeded } from './handler_verify.ts';

type LockAcquireMessage = Extract<ClientMessage, { t: 'lock.acquire' }>;

/**
 * Returns the sender's room when it is a synced member, otherwise replies with
 * an error.
 *
 * @param session Sender.
 * @param requestId Request id to echo.
 * @returns Room or null.
 */
export function sessionSyncedRoom(session: ConnectionSession, requestId: number | undefined): Room | null {
  if (!session.room) {
    sessionSendError(session, 'not_in_room', requestId);
    return null;
  }
  if (!session.synced) {
    sessionSendError(session, 'not_synced', requestId);
    return null;
  }
  return session.room;
}

/**
 * Atomically acquires a set of exclusive locks plus shared locks on their
 * ancestors (all or nothing). When a member claims ancestors it does not share
 * yet, the room owner must confirm them first; conflicts are refused before the
 * owner is asked.
 *
 * @param core Relay core.
 * @param session Requester.
 * @param message Request.
 */
export function handlerLockAcquire(core: ServerCore, session: ConnectionSession, message: LockAcquireMessage): void {
  const room = sessionSyncedRoom(session, message.r);
  if (!room) return;
  const exclusive = new Set(message.ids);
  const sharedWanted = (message.shared ?? []).filter((id) => !exclusive.has(id));
  const sharedNew = room.locks.sharedMissing(session.user, sharedWanted);
  if (!verifyNeeded(room, session, sharedNew)) return lockAcquireGrant(room, session, message);
  const conflicts = room.locks.acquireConflicts(session.user, message.ids, sharedWanted);
  if (conflicts.length > 0) return lockRefuse(session, message.r, 'lock_conflict', { conflicts });
  verifyAsk(core, room, session, { ids: message.ids, anc: sharedNew }, (outcome) => {
    if (outcome !== 'ok') return lockRefuse(session, message.r, 'lock_unverified', { why: outcome });
    if (session.room === room && session.synced) lockAcquireGrant(room, session, message);
  });
}

/**
 * Acquires the requested locks and tells the room.
 *
 * @param room Room.
 * @param session Requester.
 * @param message Request.
 */
function lockAcquireGrant(room: Room, session: ConnectionSession, message: LockAcquireMessage): void {
  const result = room.locks.acquire(session.user, message.ids, message.replace === true, message.shared);
  if (!result.ok) {
    const details = result.reason === 'lock_conflict' ? { conflicts: result.conflicts } : {};
    return lockRefuse(session, message.r, result.reason, details);
  }
  sessionSend(session, { t: 'lock.result', r: message.r, ok: true, add: result.added, remove: result.removed });
  roomBroadcastLocks(room, session, result.added, result.removed);
}

/**
 * Replies that a lock request was refused.
 *
 * @param session Requester.
 * @param requestId Request id to echo.
 * @param code Reason.
 * @param details Extra fields.
 */
function lockRefuse(
  session: ConnectionSession,
  requestId: number | undefined,
  code: 'lock_conflict' | 'lock_limit' | 'lock_unverified',
  details: object,
): void {
  sessionSend(session, { t: 'lock.result', r: requestId, ok: false, code, ...details });
}

/**
 * Releases the given locks, or all locks when no ids are given.
 *
 * @param _core Relay core.
 * @param session Requester.
 * @param message Request.
 */
export function handlerLockRelease(
  _core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'lock.release' }>,
): void {
  if (!session.room) return sessionSendError(session, 'not_in_room', message.r);
  const released = session.room.locks.release(session.user, message.ids);
  sessionSend(session, { t: 'lock.result', r: message.r, ok: true, add: [], remove: released });
  roomBroadcastLocks(session.room, session, [], released);
}
