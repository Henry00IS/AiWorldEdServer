/**
 * Chat typing presence: a member signals it is typing; the relay keeps a short
 * countdown per user, resets it on each signal, and broadcasts the list of
 * typing user ids whenever the set changes. Only members that negotiated the
 * `typing` capability send or receive these messages. Leaving clears the flag
 * before the leave is announced so a leaver cannot appear in a later list.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastCapable } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { abuseThrottled } from './handler_abuse.ts';

/**
 * Handles `typing`: starts or refreshes the sender's countdown, or clears it
 * when `stop` is set.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Typing signal.
 */
export function handlerTyping(
  core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'typing' }>,
): void {
  const room = session.room;
  if (!room || !session.synced || abuseThrottled(core, session)) return;
  if (!session.protocol.caps.has('typing')) return;
  if (message.stop === true) typingClear(room, session.user);
  else typingTouch(core, room, session.user);
}

/**
 * Starts or resets the typing countdown for a member and broadcasts when the
 * set of typers changes.
 *
 * @param core Relay core.
 * @param room Room.
 * @param user Member user id.
 */
export function typingTouch(core: ServerCore, room: Room, user: number): void {
  const started = !room.typingTimers.has(user);
  typingTimerReplace(core, room, user);
  if (started) typingBroadcast(room);
}

/**
 * Removes a member from the typing set, clears its timer, and broadcasts when
 * the set changed. Safe to call when the member was not typing.
 *
 * @param room Room.
 * @param user Member user id.
 * @returns True when the member was typing.
 */
export function typingClear(room: Room, user: number): boolean {
  const timer = room.typingTimers.get(user);
  if (timer === undefined) return false;
  clearTimeout(timer);
  room.typingTimers.delete(user);
  typingBroadcast(room);
  return true;
}

/**
 * Clears every typing flag in a room (used when the room closes).
 *
 * @param room Room.
 */
export function typingClearAll(room: Room): void {
  for (const timer of room.typingTimers.values()) clearTimeout(timer);
  room.typingTimers.clear();
}

/**
 * Replaces the countdown for one member without broadcasting.
 *
 * @param core Relay core.
 * @param room Room.
 * @param user Member user id.
 */
function typingTimerReplace(core: ServerCore, room: Room, user: number): void {
  const previous = room.typingTimers.get(user);
  if (previous !== undefined) clearTimeout(previous);
  const handle = setTimeout(() => {
    if (room.typingTimers.get(user) !== handle) return;
    room.typingTimers.delete(user);
    typingBroadcast(room);
  }, core.config.typingExpiryMs);
  room.typingTimers.set(user, handle);
}

/**
 * Broadcasts the current typing user ids to capable members.
 *
 * @param room Room.
 */
function typingBroadcast(room: Room): void {
  const users = [...room.typingTimers.keys()].sort((a, b) => a - b);
  roomBroadcastCapable(room, 'typing', { t: 'typing', users });
}
