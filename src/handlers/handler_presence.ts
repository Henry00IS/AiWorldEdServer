/**
 * Presence relay: latest-only, lowest priority. Each recipient has a mailbox
 * holding at most one frame per sender; a newer frame replaces the older one
 * and frames leave the mailbox only while the recipient's outbound queue is
 * empty and its socket buffer is nearly drained, so presence never delays or
 * queues behind edits and never builds a backlog.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import { presenceFrameCheck, presenceFrameRelay } from '../shared/presence_frame.ts';

/**
 * Validates a presence frame and offers it to every other synced member. Frames
 * from members that are not synced yet and frames over the presence rate are
 * dropped silently.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param frame Client presence frame.
 */
export function handlerPresence(core: ServerCore, session: ConnectionSession, frame: Uint8Array): void {
  if (!presenceFrameCheck(frame)) return core.violation(session, 'malformed presence frame');
  const room = session.room;
  if (!room || !session.synced || !session.presenceBucket.take(1)) return;
  const relayed = presenceFrameRelay(frame, session.user);
  room.presenceLatest.set(session.user, relayed);
  for (const member of room.members.values()) {
    if (member !== session && member.synced) presenceOffer(member, session.user, relayed);
  }
}

/**
 * Stores a frame in a recipient's mailbox (replacing the sender's older one)
 * and tries to deliver.
 *
 * @param recipient Recipient.
 * @param sender Sender user id.
 * @param frame Relayed frame.
 */
export function presenceOffer(recipient: ConnectionSession, sender: number, frame: Uint8Array): void {
  if (recipient.closed) return;
  recipient.presencePending.set(sender, frame);
  presenceFlush(recipient);
}

/**
 * Delivers the mailbox when the recipient's outbound path is idle.
 *
 * @param recipient Recipient.
 */
export function presenceFlush(recipient: ConnectionSession): void {
  if (recipient.presencePending.size === 0 || recipient.closed) return;
  for (const [sender, frame] of recipient.presencePending) {
    if (!recipient.outbound.sendIfIdle(frame, recipient.presenceHighWaterBytes)) return;
    recipient.presencePending.delete(sender);
  }
}

/**
 * Gives a member that just finished syncing the latest presence of everyone
 * else.
 *
 * @param room Room.
 * @param member Newly synced member.
 */
export function presenceCatchUp(room: Room, member: ConnectionSession): void {
  for (const [sender, frame] of room.presenceLatest) if (sender !== member.user) presenceOffer(member, sender, frame);
}

/**
 * Forgets everything a leaving member sent or was about to receive.
 *
 * @param room Room the member left.
 * @param member Leaving member.
 */
export function presencePurge(room: Room, member: ConnectionSession): void {
  room.presenceLatest.delete(member.user);
  member.presencePending.clear();
  for (const other of room.members.values()) other.presencePending.delete(member.user);
}
