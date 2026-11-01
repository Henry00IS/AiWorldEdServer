/** Live room list: `room.subscribe` and `room.unsubscribe`. */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { ServerCore } from '../server/server_core.ts';

/**
 * Subscribes the sender to room list pushes and replies with the full list.
 *
 * @param core Relay core.
 * @param session Subscriber.
 * @param message Request.
 */
export function handlerRoomSubscribe(core: ServerCore, session: ConnectionSession, message: { r?: number }): void {
  const result = core.roomListSubscriptions.subscribe(session, message.r);
  if (result !== 'ok') sessionSendError(session, result, message.r);
}

/**
 * Ends the sender's room list subscription. Unsubscribing without a
 * subscription is not an error.
 *
 * @param core Relay core.
 * @param session Subscriber.
 * @param message Request.
 */
export function handlerRoomUnsubscribe(core: ServerCore, session: ConnectionSession, message: { r?: number }): void {
  core.roomListSubscriptions.unsubscribe(session);
  sessionSend(session, { t: 'room.unsubscribed', ...(message.r === undefined ? {} : { r: message.r }) });
}
