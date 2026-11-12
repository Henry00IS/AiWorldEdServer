/**
 * Toy relay: every member publishes snapshots of the toys it owns and simulates
 * (the balls it threw). The relay stamps the sender as the owner, so nobody can
 * publish someone else's toys. Snapshots travel like presence: latest-only per
 * sender, through the recipient mailbox, delivered only while the recipient's
 * outbound path is idle, so they never delay or queue behind edits. Full and
 * changes-only snapshots have a slot each per sender, and a full snapshot drops
 * the undelivered changes it supersedes; joiners get the latest full snapshot
 * of every member. Only connections that negotiated the `toys` capability send
 * or receive them.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import { toyFrameCheck, toyFrameIsFull, toyFrameRelay } from '../shared/toy_frame.ts';
import { abuseRecord, abuseThrottled } from './handler_abuse.ts';
import { presenceOffer } from './handler_presence.ts';

/** Capability that enables toy frames. */
export const TOY_CAPABILITY = 'toys';
/** Abuse points for each toy frame over the member's rate. */
export const TOY_FLOOD_POINTS = 1;
/** Mailbox key offset of full toy snapshots (above every presence key). */
const TOY_MAILBOX_SNAPSHOT = 2 ** 32;
/** Mailbox key offset of changes-only toy snapshots. */
const TOY_MAILBOX_CHANGES = 2 * 2 ** 32;

/**
 * Tells whether a connection negotiated toy frames.
 *
 * @param session Connection.
 * @returns True when it may send and receive them.
 */
function toyCapable(session: ConnectionSession): boolean {
  return session.protocol.caps.has(TOY_CAPABILITY);
}

/**
 * Validates a member's snapshot of its own toys and offers it to every other
 * synced member with the capability. Malformed frames close the connection;
 * snapshots from unsynced members are dropped. Each snapshot over the member's
 * rate is dropped and scores abuse points; past the throttle score nothing is
 * relayed, and a flood that goes on is closed with 4007. Snapshots within the
 * rate never score, so the score of a member that calms down decays.
 *
 * @param core Relay core.
 * @param session Sender, the owner of every toy in the frame.
 * @param frame Client snapshot frame.
 */
export function handlerToy(core: ServerCore, session: ConnectionSession, frame: Uint8Array): void {
  if (!toyCapable(session)) return core.violation(session, 'toy frame without capability');
  if (!toyFrameCheck(frame)) return core.violation(session, 'malformed toy frame');
  const room = session.room;
  if (!room || !session.synced) return;
  if (!session.toyBucket.take(1)) return abuseRecord(core, session, TOY_FLOOD_POINTS, 'toy flood');
  if (abuseThrottled(core, session)) return;
  const relayed = toyFrameRelay(frame, session.user);
  const full = toyFrameIsFull(frame);
  if (full) room.toyLatest.set(session.user, relayed);
  for (const member of room.members.values()) {
    if (member !== session && member.synced && toyCapable(member)) toyOffer(member, session.user, relayed, full);
  }
}

/**
 * Offers a snapshot to one member: a full snapshot replaces both slots of its
 * sender and goes after anything still pending, a changes-only one replaces the
 * older changes.
 *
 * @param member Recipient.
 * @param sender Sender user id.
 * @param relayed Relayed snapshot frame.
 * @param full Whether it lists every toy of the sender.
 */
function toyOffer(member: ConnectionSession, sender: number, relayed: Uint8Array, full: boolean): void {
  if (!full) return presenceOffer(member, TOY_MAILBOX_CHANGES + sender, relayed);
  member.presencePending.delete(TOY_MAILBOX_CHANGES + sender);
  member.presencePending.delete(TOY_MAILBOX_SNAPSHOT + sender);
  presenceOffer(member, TOY_MAILBOX_SNAPSHOT + sender, relayed);
}

/**
 * Gives a member that just finished syncing every other member's latest full
 * snapshot.
 *
 * @param room Room.
 * @param member Newly synced member.
 */
export function toyCatchUp(room: Room, member: ConnectionSession): void {
  if (!toyCapable(member)) return;
  room.toyLatest.forEach((relayed, sender) => {
    if (sender !== member.user) presenceOffer(member, TOY_MAILBOX_SNAPSHOT + sender, relayed);
  });
}

/**
 * Forgets a leaving member's latest snapshot and the frames it sent that were
 * not delivered yet.
 *
 * @param room Room the member left.
 * @param member Leaving member.
 */
export function toyPurge(room: Room, member: ConnectionSession): void {
  room.toyLatest.delete(member.user);
  for (const other of room.members.values()) {
    other.presencePending.delete(TOY_MAILBOX_SNAPSHOT + member.user);
    other.presencePending.delete(TOY_MAILBOX_CHANGES + member.user);
  }
}
