/**
 * Display name changes. A name is fixed while the session is in a room: the
 * name a member joined with stays its name until it leaves.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { displayNameNormalize } from '../shared/room_name_policy.ts';

/**
 * Handles `name.set`: refuses with `name_locked` inside a room, otherwise
 * validates the name and replies `name.changed` with the normalized name.
 *
 * @param session Sender.
 * @param message Validated request.
 */
export function handlerNameSet(session: ConnectionSession, message: Extract<ClientMessage, { t: 'name.set' }>): void {
  if (session.room) return sessionSendError(session, 'name_locked', message.r);
  const name = displayNameNormalize(message.name);
  if (!name.ok) return sessionSendError(session, 'invalid_name', message.r, { reason: name.reason, field: 'name' });
  session.name = name.name;
  session.nameChosen = name.name;
  sessionSend(session, { t: 'name.changed', ...(message.r === undefined ? {} : { r: message.r }), name: name.name });
}
