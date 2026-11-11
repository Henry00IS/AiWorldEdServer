/**
 * Room chat: normalized, rate limited and relayed to the members in the room at
 * that moment. Nothing is stored, so members only see messages sent while they
 * are in the room. Delivery has lower priority than edits and streams: each
 * recipient keeps a short FIFO that drains only while its outbound queue is
 * empty, ahead of presence.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import { CHAT_EDIT_WINDOW_MS, chatTextNormalize } from '../shared/chat_text_policy.ts';
import type { ChatFileAttachment, ChatMessageEntry, ClientMessage } from '../shared/protocol_definitions.ts';
import { transferMimeSanitize, transferNameSanitize } from '../shared/transfer_file_policy.ts';
import { handlerTransferLinkOwner } from './handler_transfer.ts';

/** Most messages per room kept for editing. */
const CHAT_EDITABLE_MAXIMUM = 512;

/** Client chat message. */
type ChatClientMessage = Extract<ClientMessage, { t: 'chat' }>;

/**
 * Handles `chat`: checks membership, the send interval and the text, then
 * replies `chat.sent` to the sender and offers the message to every other
 * member.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated chat message.
 */
export function handlerChat(core: ServerCore, session: ConnectionSession, message: ChatClientMessage): void {
  const room = session.room;
  if (!room) return sessionSendError(session, 'not_in_room', message.r);
  const now = Date.now();
  const text = chatAdmit(core, session, message, now);
  if (text === null) return;
  const file = chatFile(core, session, message);
  if (file === null) return sessionSendError(session, 'transfer_unavailable', message.r);
  session.chatLastAt = now;
  const entry: ChatMessageEntry = {
    id: ++room.chatSequence,
    from: session.user,
    name: session.name,
    color: room.colorOf(session.user),
    text,
    at: now,
    ...(file === undefined ? {} : { file }),
  };
  sessionSend(session, { t: 'chat.sent', ...(message.r === undefined ? {} : { r: message.r }), ...entry });
  chatEditableRemember(room, entry);
  chatRelay(core, room, session, entry);
}

/**
 * Checks and cleans a shared file: the link must be live and the sender must
 * have agreed on `transfer`; name and type are sanitized like the download
 * headers.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated chat message.
 * @returns Clean attachment, undefined without one, or null when refused.
 */
function chatFile(
  core: ServerCore,
  session: ConnectionSession,
  message: ChatClientMessage,
): ChatFileAttachment | undefined | null {
  const file = message.file;
  if (file === undefined) return undefined;
  if (!session.protocol.caps.has('transfer') || handlerTransferLinkOwner(core, file.link) !== session.transfer)
    return null;
  const name = transferNameSanitize(file.name, file.link);
  return { link: file.link, name, size: file.size, mime: transferMimeSanitize(file.mime) };
}

/**
 * Checks the send interval and normalizes the text, replying with an error when
 * the message is refused.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated chat message.
 * @param now Current time (epoch ms).
 * @returns Normalized text, or null when refused.
 */
function chatAdmit(
  core: ServerCore,
  session: ConnectionSession,
  message: ChatClientMessage,
  now: number,
): string | null {
  const retryAfterMs = Math.ceil(session.chatLastAt + core.config.chatIntervalMs - now);
  if (retryAfterMs > 0) {
    sessionSendError(session, 'chat_rate_limited', message.r, { retryAfterMs });
    return null;
  }
  const limits = { length: core.config.chatTextLengthMaximum, lines: core.config.chatTextLinesMaximum };
  const text = chatTextNormalize(message.text, limits);
  if (text.ok) return text.text;
  sessionSendError(session, 'invalid_chat', message.r, { reason: text.reason });
  return null;
}

/**
 * Remembers who sent a message and when, so its sender may edit it for a few
 * minutes; messages past that time are forgotten.
 *
 * @param room Room of the message.
 * @param entry Chat message.
 */
function chatEditableRemember(room: Room, entry: ChatMessageEntry): void {
  room.chatEditable.set(entry.id, { from: entry.from, at: entry.at, edits: 0 });
  chatEditableForget(room, entry.at);
}

/**
 * Forgets the oldest messages that can no longer be edited, and the oldest
 * beyond the cap.
 *
 * @param room Room.
 * @param now Current time (epoch ms).
 */
export function chatEditableForget(room: Room, now: number): void {
  for (const [id, editable] of room.chatEditable) {
    const crowded = room.chatEditable.size > CHAT_EDITABLE_MAXIMUM;
    if (!crowded && now - editable.at <= CHAT_EDIT_WINDOW_MS) return;
    room.chatEditable.delete(id);
  }
}

/**
 * Offers a chat message to every member of the room except the sender.
 *
 * @param core Relay core.
 * @param room Room of the sender.
 * @param sender Sender.
 * @param entry Chat message.
 */
function chatRelay(core: ServerCore, room: Room, sender: ConnectionSession, entry: ChatMessageEntry): void {
  const frame = JSON.stringify({ t: 'chat', ...entry });
  for (const member of room.members.values()) {
    if (member !== sender) chatOffer(member, frame, core.config.chatPendingPerRecipient);
  }
}

/**
 * Appends a chat message to a recipient's FIFO, dropping the oldest when it is
 * full, and tries to deliver.
 *
 * @param recipient Recipient.
 * @param frame Serialized chat message.
 * @param pendingMaximum Most messages held for the recipient.
 */
export function chatOffer(recipient: ConnectionSession, frame: string, pendingMaximum: number): void {
  if (recipient.closed) return;
  recipient.chatPending.push(frame);
  if (recipient.chatPending.length > pendingMaximum) recipient.chatPending.shift();
  chatFlush(recipient);
}

/**
 * Sends waiting chat messages in order while the recipient's outbound queue is
 * empty and its socket buffer is below the low-priority mark; runs again when
 * the queue drains.
 *
 * @param recipient Recipient.
 */
export function chatFlush(recipient: ConnectionSession): void {
  while (recipient.chatPending.length > 0 && !recipient.closed) {
    const [frame] = recipient.chatPending;
    if (frame === undefined || !recipient.outbound.sendIfIdle(frame, recipient.presenceHighWaterBytes)) return;
    recipient.chatPending.shift();
  }
}

/**
 * Drops every chat message still waiting for a member that leaves its room, so
 * nothing from that room reaches it later.
 *
 * @param member Member leaving the room.
 */
export function chatPurge(member: ConnectionSession): void {
  member.chatPending.length = 0;
}
