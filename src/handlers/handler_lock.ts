/**
 * Edit leases: acquire, renew, release and expiry. Each member runs at most one
 * operation at a time; its locks all belong to that one lease.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcast, roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { abuseRecord, abuseThrottled } from './handler_abuse.ts';
import { verifyAsk, verifyNeeded } from './handler_verify.ts';

type LockAcquireMessage = Extract<ClientMessage, { t: 'lock.acquire' }>;
type LockRefusalCode =
  'lock_conflict' | 'lock_limit' | 'lock_unverified' | 'lease_busy' | 'lease_stale' | 'rate_limited' | 'throttled';

/** A refused lease request and how much misuse it shows. */
interface LeaseRefusal {
  readonly code: LockRefusalCode;
  readonly points: number;
}

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
  const refusal = leaseRefusal(core, room, session, message);
  if (refusal) {
    abuseRecord(core, session, refusal.points, `lock ${refusal.code}`);
    return lockRefuse(session, message.r, refusal.code, {});
  }
  const exclusive = new Set(message.ids);
  const sharedWanted = (message.shared ?? []).filter((id) => !exclusive.has(id));
  const sharedNew = room.locks.sharedMissing(session.user, sharedWanted);
  if (!verifyNeeded(room, session, sharedNew)) return lockAcquireGrant(room, session, message);
  const conflicts = room.locks.acquireConflicts(session.user, message.ids, sharedWanted);
  if (conflicts.length > 0) return lockRefuse(session, message.r, 'lock_conflict', { conflicts });
  verifyAsk(core, room, session, { ids: message.ids, anc: sharedNew }, (outcome) => {
    if (outcome !== 'ok') return lockRefuse(session, message.r, 'lock_unverified', { why: outcome });
    if (session.room !== room || !session.synced) return;
    const late = leaseConflict(room, session, message);
    if (late) return lockRefuse(session, message.r, late, {});
    lockAcquireGrant(room, session, message);
  });
}

/**
 * Checks the one-operation rule, throttling and the new-lease rate before an
 * acquire.
 *
 * @param core Relay core.
 * @param room Room.
 * @param session Requester.
 * @param message Request.
 * @returns Refusal with its misuse weight, or null.
 */
function leaseRefusal(
  core: ServerCore,
  room: Room,
  session: ConnectionSession,
  message: LockAcquireMessage,
): LeaseRefusal | null {
  if (abuseThrottled(core, session)) return { code: 'throttled', points: 0 };
  const conflict = leaseConflict(room, session, message);
  if (conflict) return { code: conflict, points: 1 };
  if (room.locks.leases.of(session.user)?.id === message.lease) return null;
  if (!session.limits.leaseBucket.take()) return { code: 'rate_limited', points: 1 };
  return null;
}

/**
 * Checks a lease number against the member's running and past leases: the
 * running number extends the operation, a new higher number needs `replace`
 * while another operation runs, and a number already used is stale.
 *
 * @param room Room.
 * @param session Requester.
 * @param message Request.
 * @returns Refusal code, or null.
 */
function leaseConflict(
  room: Room,
  session: ConnectionSession,
  message: LockAcquireMessage,
): 'lease_busy' | 'lease_stale' | null {
  const running = room.locks.leases.of(session.user);
  if (running?.id === message.lease) return null;
  if (message.lease <= room.locks.leases.lastId(session.user)) return 'lease_stale';
  if (running && message.replace !== true) return 'lease_busy';
  return null;
}

/**
 * Acquires the requested locks and tells the room.
 *
 * @param room Room.
 * @param session Requester.
 * @param message Request.
 */
function lockAcquireGrant(room: Room, session: ConnectionSession, message: LockAcquireMessage): void {
  const running = room.locks.leases.of(session.user);
  const replace = message.replace === true || (running !== undefined && running.id !== message.lease);
  const result = room.locks.acquire(session.user, message.ids, replace, message.shared);
  if (!result.ok) {
    const details = result.reason === 'lock_conflict' ? { conflicts: result.conflicts } : {};
    return lockRefuse(session, message.r, result.reason, details);
  }
  if (room.locks.leases.of(session.user)?.id === message.lease) room.locks.leases.renew(session.user, message.lease);
  else if (room.locks.countFor(session.user) > 0) room.locks.leases.begin(session.user, message.lease);
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
  code: LockRefusalCode,
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

/**
 * Pushes out the deadline of the sender's running lease. Renewals keep an
 * operation alive while the user still holds the mouse or key; without edits
 * they stop working after the idle maximum. Floods count as misuse; a renewal
 * of a lease that already ended is dropped silently.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Renewal.
 */
export function handlerLockRenew(
  core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'lock.renew' }>,
): void {
  if (!session.room || !session.synced) return;
  if (!session.limits.renewBucket.take()) return abuseRecord(core, session, 1, 'lease renew flood');
  session.room.locks.leases.renew(session.user, message.lease);
}

/**
 * Ends every lease whose holder stopped renewing, stopped making progress or
 * ran past the absolute cap, and tells the whole room (the holder included) so
 * previews revert to the committed state.
 *
 * @param core Relay core.
 */
export function leasesSweep(core: ServerCore): void {
  for (const room of core.registry.all()) {
    if (room.locks.leases.count() === 0) continue;
    for (const user of room.locks.leases.expired()) leaseExpire(room, user);
  }
}

/**
 * Releases the locks of an expired lease and broadcasts it.
 *
 * @param room Room.
 * @param user Holder.
 */
function leaseExpire(room: Room, user: number): void {
  const released = room.locks.release(user);
  room.locks.leases.end(user);
  roomBroadcast(room, { t: 'locks', by: user, ...(released.length ? { remove: released } : {}), expired: true });
}
