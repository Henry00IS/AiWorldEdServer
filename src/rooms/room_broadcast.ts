/** Room-wide message fan-out helpers. */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from './room.ts';

/**
 * Serializes a message once and queues it for every member except one.
 *
 * @param room Room to broadcast in.
 * @param message Message object.
 * @param exceptUser User id to skip, if any.
 */
export function roomBroadcast(room: Room, message: object, exceptUser?: number): void {
  const serialized = JSON.stringify(message);
  for (const member of room.members.values()) {
    if (member.user !== exceptUser && !member.closed) member.outbound.pushText(serialized);
  }
}

/**
 * Broadcasts a lock change of one user to everyone else in the room.
 *
 * @param room Room.
 * @param by User whose locks changed.
 * @param added Newly locked ids.
 * @param removed Released ids.
 */
export function roomBroadcastLocks(
  room: Room,
  by: ConnectionSession,
  added: readonly string[],
  removed: readonly string[],
): void {
  if (added.length === 0 && removed.length === 0) return;
  roomBroadcast(
    room,
    {
      t: 'locks',
      by: by.user,
      ...(added.length ? { add: added } : {}),
      ...(removed.length ? { remove: removed } : {}),
    },
    by.user,
  );
}
