/**
 * Chat reactions (capability `chat.react`): members add or remove one emoji at
 * a time on a recent chat message. The relay keeps who reacted with what in
 * memory for the recent messages only, caps the emoji per message, the
 * reactions per message and per member, limits the rate, and offers each change
 * to the other capable members through the same low-priority FIFO as chat, so a
 * reaction never overtakes its message.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room, RoomChatReactable } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import {
  CHAT_REACTION_AGE_MAXIMUM_MS,
  CHAT_REACTION_EMOJIS_PER_MESSAGE_MAXIMUM,
  CHAT_REACTION_MESSAGES_MAXIMUM,
  CHAT_REACTION_WINDOW_MS,
  CHAT_REACTIONS_PER_MEMBER_MAXIMUM,
  CHAT_REACTIONS_PER_MESSAGE_MAXIMUM,
  CHAT_REACTIONS_PER_WINDOW,
  chatReactionEmojiIs,
} from '../shared/chat_text_policy.ts';
import type { ChatReactionMessage, ClientMessage } from '../shared/protocol_definitions.ts';
import { chatOffer } from './handler_chat.ts';

/** Client reaction request. */
type ChatReactClientMessage = Extract<ClientMessage, { t: 'chat.react' }>;

/** Why a reaction was refused. */
type ChatReactRefusal = 'unsupported' | 'not_found' | 'expired' | 'invalid_emoji' | 'too_many';

/**
 * Handles `chat.react`: checks the change, applies it, replies `chat.reaction`
 * to the member and offers it to the other members that speak `chat.react`. A
 * change that is already in effect is answered but not relayed.
 *
 * @param core Relay core.
 * @param session Reacting member.
 * @param message Validated reaction request.
 */
export function handlerChatReact(core: ServerCore, session: ConnectionSession, message: ChatReactClientMessage): void {
  const room = session.room;
  if (!room) return sessionSendError(session, 'not_in_room', message.r);
  const now = Date.now();
  if (!chatReactRateAdmit(session, message, now)) return;
  chatReactableForget(room, now);
  const reactable = room.chatReactable.get(message.id);
  const reason = chatReactRefusal(session, room, message, reactable);
  if (reason !== null || reactable === undefined)
    return sessionSendError(session, 'chat_react_refused', message.r, { reason: reason ?? 'not_found' });
  const changed = chatReactApply(reactable, session.user, message.emoji, message.on);
  const reaction: ChatReactionMessage = {
    t: 'chat.reaction',
    id: message.id,
    from: session.user,
    emoji: message.emoji,
    on: message.on,
  };
  sessionSend(session, { ...reaction, ...(message.r === undefined ? {} : { r: message.r }) });
  if (changed) chatReactRelay(core, room, session, JSON.stringify(reaction));
}

/**
 * Remembers a new chat message so members can react to it, forgetting the
 * oldest beyond the age and count limits.
 *
 * @param room Room of the message.
 * @param id Message id.
 * @param at Relay time of the message (epoch ms).
 */
export function chatReactableRemember(room: Room, id: number, at: number): void {
  room.chatReactable.set(id, { at, reactions: new Map(), total: 0 });
  chatReactableForget(room, at);
}

/**
 * Forgets the reactions of the oldest messages past the age limit or beyond the
 * count limit.
 *
 * @param room Room.
 * @param now Current time (epoch ms).
 */
function chatReactableForget(room: Room, now: number): void {
  for (const [id, reactable] of room.chatReactable) {
    const crowded = room.chatReactable.size > CHAT_REACTION_MESSAGES_MAXIMUM;
    if (!crowded && now - reactable.at <= CHAT_REACTION_AGE_MAXIMUM_MS) return;
    room.chatReactable.delete(id);
  }
}

/**
 * Admits a reaction change within the session's rate window, replying with
 * `chat_rate_limited` otherwise.
 *
 * @param session Reacting member.
 * @param message Validated reaction request.
 * @param now Current time (epoch ms).
 * @returns True when admitted.
 */
function chatReactRateAdmit(session: ConnectionSession, message: ChatReactClientMessage, now: number): boolean {
  const times = session.chatReactTimes;
  while (times.length > 0 && now - (times[0] ?? 0) >= CHAT_REACTION_WINDOW_MS) times.shift();
  if (times.length >= CHAT_REACTIONS_PER_WINDOW) {
    const retryAfterMs = Math.ceil((times[0] ?? now) + CHAT_REACTION_WINDOW_MS - now);
    sessionSendError(session, 'chat_rate_limited', message.r, { retryAfterMs });
    return false;
  }
  times.push(now);
  return true;
}

/**
 * Returns why a reaction change may not go ahead.
 *
 * @param session Reacting member.
 * @param room Room of the member.
 * @param message Validated reaction request.
 * @param reactable Reactions of the message, if it is still kept.
 * @returns Refusal, or null when the change may go ahead.
 */
function chatReactRefusal(
  session: ConnectionSession,
  room: Room,
  message: ChatReactClientMessage,
  reactable: RoomChatReactable | undefined,
): ChatReactRefusal | null {
  if (!session.protocol.caps.has('chat.react')) return 'unsupported';
  if (reactable === undefined) return message.id <= room.chatSequence ? 'expired' : 'not_found';
  if (!chatReactionEmojiIs(message.emoji)) return 'invalid_emoji';
  const users = reactable.reactions.get(message.emoji);
  if (!message.on || users?.has(session.user) === true) return null;
  return chatReactRoom(reactable, session.user, users === undefined) ? null : 'too_many';
}

/**
 * Returns whether a message has room for one more reaction of a member.
 *
 * @param reactable Reactions of the message.
 * @param user Reacting member.
 * @param emojiNew True when the emoji is not on the message yet.
 * @returns True within every cap.
 */
function chatReactRoom(reactable: RoomChatReactable, user: number, emojiNew: boolean): boolean {
  if (emojiNew && reactable.reactions.size >= CHAT_REACTION_EMOJIS_PER_MESSAGE_MAXIMUM) return false;
  if (reactable.total >= CHAT_REACTIONS_PER_MESSAGE_MAXIMUM) return false;
  let own = 0;
  for (const users of reactable.reactions.values()) if (users.has(user)) own += 1;
  return own < CHAT_REACTIONS_PER_MEMBER_MAXIMUM;
}

/**
 * Adds or removes a member's reaction.
 *
 * @param reactable Reactions of the message.
 * @param user Reacting member.
 * @param emoji Checked emoji.
 * @param on True to add, false to remove.
 * @returns True when something changed.
 */
function chatReactApply(reactable: RoomChatReactable, user: number, emoji: string, on: boolean): boolean {
  const users = reactable.reactions.get(emoji) ?? new Set<number>();
  if (users.has(user) === on) return false;
  if (on) users.add(user);
  else users.delete(user);
  reactable.total += on ? 1 : -1;
  if (users.size === 0) reactable.reactions.delete(emoji);
  else reactable.reactions.set(emoji, users);
  return true;
}

/**
 * Offers a reaction change to every other member of the room that speaks
 * `chat.react`.
 *
 * @param core Relay core.
 * @param room Room of the member.
 * @param sender Reacting member.
 * @param frame Serialized `chat.reaction` message.
 */
function chatReactRelay(core: ServerCore, room: Room, sender: ConnectionSession, frame: string): void {
  for (const member of room.members.values()) {
    if (member !== sender && member.protocol.caps.has('chat.react'))
      chatOffer(member, frame, core.config.chatPendingPerRecipient);
  }
}
