/** Owner-only connection-scoped editing grants and room removal. */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import { roomBroadcast } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { leaseExpire } from './handler_lock.ts';
import { roomMembershipEnd } from './handler_room.ts';
import { verifyCancel } from './handler_verify.ts';

/**
 * Routes permission and kick controls, accepting only the current room owner.
 *
 * @param core Relay core.
 * @param sender Actor derived from the connection.
 * @param message Validated client request.
 * @returns Whether this was a member control.
 */
export function handlerMemberControl(core: ServerCore, sender: ConnectionSession, message: ClientMessage): boolean {
  if (message.t !== 'member.permission.set' && message.t !== 'member.kick') return false;
  const room = sender.room;
  if (!room) sessionSendError(sender, 'not_in_room', message.r);
  else if (room.owner !== sender) sessionSendError(sender, 'not_owner', message.r);
  else {
    const target = room.members.get(message.user);
    if (!target || target === sender) sessionSendError(sender, 'member_not_found', message.r);
    else if (message.t === 'member.kick') {
      roomMembershipEnd(core, target, 'kicked');
      sessionSend(sender, { t: 'member.kicked', r: message.r, user: target.user });
    } else memberPermissionSet(core, target, message.canEdit, message.r);
  }
  return true;
}

/**
 * Applies a grant and expires revoked leases and pending writes before
 * broadcasting.
 *
 * @param core Relay core.
 * @param target Current member.
 * @param allowed New edit permission.
 * @param requestId Owner request to acknowledge.
 */
function memberPermissionSet(core: ServerCore, target: ConnectionSession, allowed: boolean, requestId?: number): void {
  const room = target.room;
  if (!room) return;
  room.permissionSet(target.user, allowed);
  if (!allowed) memberWritesCancel(core, target);
  roomBroadcast(room, { t: 'member.permission', user: target.user, canEdit: allowed });
  sessionSend(room.owner, { t: 'member.permission.result', r: requestId, user: target.user, canEdit: allowed });
}

/**
 * Refuses parked writes and releases previews and both kinds of editing lock.
 *
 * @param core Relay core.
 * @param target Revoked member.
 */
function memberWritesCancel(core: ServerCore, target: ConnectionSession): void {
  const room = target.room;
  if (!room) return;
  const held = [];
  for (let message = target.verify.next(); message !== undefined; message = target.verify.next()) held.push(message);
  verifyCancel(target, 'read_only');
  for (const message of held) core.lockOrEditRoute(target, message);
  room.customLocks.release(target.user);
  leaseExpire(room, target.user);
}
