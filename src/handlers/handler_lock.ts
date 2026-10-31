/**
 * Selection lock acquire and release.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';

/**
 * Returns the sender's room when it is a synced member, otherwise replies with an error.
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
 * Atomically acquires a set of locks (all or nothing).
 *
 * @param _core Relay core.
 * @param session Requester.
 * @param message Request.
 */
export function handlerLockAcquire(_core: ServerCore, session: ConnectionSession, message: Extract<ClientMessage, { t: 'lock.acquire' }>): void {
  const room = sessionSyncedRoom(session, message.r);
  if (!room) return;
  const result = room.locks.acquire(session.user, message.ids, message.replace === true);
  if (!result.ok) {
    const details = result.reason === 'lock_conflict' ? { conflicts: result.conflicts } : {};
    return sessionSend(session, { t: 'lock.result', r: message.r, ok: false, code: result.reason, ...details });
  }
  sessionSend(session, { t: 'lock.result', r: message.r, ok: true, add: result.added, remove: result.removed });
  roomBroadcastLocks(room, session, result.added, result.removed);
}

/**
 * Releases the given locks, or all locks when no ids are given.
 *
 * @param _core Relay core.
 * @param session Requester.
 * @param message Request.
 */
export function handlerLockRelease(_core: ServerCore, session: ConnectionSession, message: Extract<ClientMessage, { t: 'lock.release' }>): void {
  if (!session.room) return sessionSendError(session, 'not_in_room', message.r);
  const released = session.room.locks.release(session.user, message.ids);
  sessionSend(session, { t: 'lock.result', r: message.r, ok: true, add: [], remove: released });
  roomBroadcastLocks(session.room, session, [], released);
}
