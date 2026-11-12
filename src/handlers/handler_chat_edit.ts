/**
 * Chat edits (capability `chat.edit`): the sender of a message may replace its
 * text for a few minutes after sending it. The relay checks the sender, the
 * age, the number of edits and the edit interval, normalizes the text like a
 * new message, replies `chat.edited` and offers the edit to the other capable
 * members through the same low-priority FIFO as chat, so it never overtakes its
 * message.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room, RoomChatEditable } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import {
  CHAT_EDIT_INTERVAL_MS,
  CHAT_EDITS_PER_MESSAGE_MAXIMUM,
  chatTextNormalize,
} from '../shared/chat_text_policy.ts';
import type { ChatEditedMessage, ClientMessage } from '../shared/protocol_definitions.ts';
import { chatEditableForget, chatOffer } from './handler_chat.ts';

/** Client chat edit request. */
type ChatEditClientMessage = Extract<ClientMessage, { t: 'chat.edit' }>;

/** Why an edit was refused. */
type ChatEditRefusal = 'unsupported' | 'not_found' | 'not_author' | 'expired' | 'too_many';

/**
 * Handles `chat.edit`: checks the edit, replies `chat.edited` to the sender and
 * offers it to the other members that speak `chat.edit`.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated edit request.
 */
export function handlerChatEdit(core: ServerCore, session: ConnectionSession, message: ChatEditClientMessage): void {
  const room = session.room;
  if (!room) return sessionSendError(session, 'not_in_room', message.r);
  const now = Date.now();
  const editable = chatEditAdmit(session, room, message, now);
  if (editable === null) return;
  const text = chatEditText(core, session, message);
  if (text === null) return;
  session.chatEditLastAt = now;
  editable.edits += 1;
  const edited: ChatEditedMessage = { t: 'chat.edited', id: message.id, from: session.user, text, at: now };
  sessionSend(session, { ...edited, ...(message.r === undefined ? {} : { r: message.r }) });
  chatEditRelay(core, room, session, JSON.stringify(edited));
}

/**
 * Checks the edit interval, then the message: it must exist, belong to the
 * sender, be young enough and have edits left. Replies with an error when
 * refused.
 *
 * @param session Sender.
 * @param room Room of the sender.
 * @param message Validated edit request.
 * @param now Current time (epoch ms).
 * @returns The editable message, or null when refused.
 */
function chatEditAdmit(
  session: ConnectionSession,
  room: Room,
  message: ChatEditClientMessage,
  now: number,
): RoomChatEditable | null {
  const retryAfterMs = Math.ceil(session.chatEditLastAt + CHAT_EDIT_INTERVAL_MS - now);
  if (retryAfterMs > 0) {
    sessionSendError(session, 'chat_rate_limited', message.r, { retryAfterMs });
    return null;
  }
  chatEditableForget(room, now);
  const editable = room.chatEditable.get(message.id);
  const reason = chatEditRefusal(session, room, message.id, editable);
  if (reason === null && editable !== undefined) return editable;
  sessionSendError(session, 'chat_edit_refused', message.r, { reason: reason ?? 'not_found' });
  return null;
}

/**
 * Returns why a message may not be edited by a session.
 *
 * @param session Sender of the edit.
 * @param room Room of the sender.
 * @param id Message id.
 * @param editable Remembered message, if still editable.
 * @returns Refusal, or null when the edit may go ahead.
 */
function chatEditRefusal(
  session: ConnectionSession,
  room: Room,
  id: number,
  editable: RoomChatEditable | undefined,
): ChatEditRefusal | null {
  if (!session.protocol.caps.has('chat.edit')) return 'unsupported';
  if (editable === undefined) return id <= room.chatSequence ? 'expired' : 'not_found';
  if (editable.from !== session.user) return 'not_author';
  return editable.edits >= CHAT_EDITS_PER_MESSAGE_MAXIMUM ? 'too_many' : null;
}

/**
 * Normalizes the new text like a new message, replying with an error when it is
 * refused.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated edit request.
 * @returns Normalized text, or null when refused.
 */
function chatEditText(core: ServerCore, session: ConnectionSession, message: ChatEditClientMessage): string | null {
  const limits = { length: core.config.chatTextLengthMaximum, lines: core.config.chatTextLinesMaximum };
  const text = chatTextNormalize(message.text, limits);
  if (text.ok) return text.text;
  sessionSendError(session, 'invalid_chat', message.r, { reason: text.reason });
  return null;
}

/**
 * Offers an edit to every other member of the room that speaks `chat.edit`.
 *
 * @param core Relay core.
 * @param room Room of the sender.
 * @param sender Sender.
 * @param frame Serialized `chat.edited` message.
 */
function chatEditRelay(core: ServerCore, room: Room, sender: ConnectionSession, frame: string): void {
  for (const member of room.members.values()) {
    if (member !== sender && member.protocol.caps.has('chat.edit'))
      chatOffer(member, frame, core.config.chatPendingPerRecipient);
  }
}
