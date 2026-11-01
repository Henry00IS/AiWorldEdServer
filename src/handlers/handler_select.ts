/**
 * Selection presence: selecting never locks. A member's selection is relayed to
 * the others so they can outline it; the relay keeps nothing (clients send
 * their selection again when someone joins). Floods are dropped. Only members
 * that negotiated the `select` capability receive selections.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import { roomBroadcastCapable } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { abuseThrottled } from './handler_abuse.ts';

/**
 * Relays a member's selection to the rest of the room.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Selection.
 */
export function handlerSelect(
  core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'select' }>,
): void {
  const room = session.room;
  if (!room || !session.synced || abuseThrottled(core, session)) return;
  if (!session.limits.selectBucket.take()) return;
  roomBroadcastCapable(room, 'select', { t: 'selected', by: session.user, ids: message.ids }, session.user);
}
