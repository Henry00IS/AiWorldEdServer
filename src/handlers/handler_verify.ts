/**
 * Owner verification of claimed ancestors. Before a member gets shared locks on
 * containers it does not hold yet, the relay asks the room owner (the source of
 * truth for the hierarchy) whether the claim is true. The relay keeps no
 * hierarchy of its own: per member it keeps one open query and the lock and
 * edit messages that arrived behind it.
 */
import type { ConnectionVerifyHeldMessage, ConnectionVerifyOutcome } from '../connection/connection_verify_state.ts';
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import { CLOSE_CODES, type ClientMessage, type VerifyQueryMessage } from '../shared/protocol_definitions.ts';

/** Ids the owner is asked about. */
export interface VerifyClaim {
  ids: string[];
  anc: string[];
}

/**
 * Returns whether a member's claim must be confirmed by the owner: the owner
 * itself is trusted, and claims that add no shared lock change nothing.
 *
 * @param room Room.
 * @param session Claiming member.
 * @param sharedNew Shared lock ids the claim would add.
 * @returns True when the owner must be asked.
 */
export function verifyNeeded(room: Room, session: ConnectionSession, sharedNew: readonly string[]): boolean {
  return session !== room.owner && sharedNew.length > 0;
}

/**
 * Asks the owner to confirm a claim and calls `resume` with the outcome:
 * immediately when the member or room is over its query rate, otherwise on the
 * answer, on timeout or when the room closes.
 *
 * @param core Relay core.
 * @param room Room.
 * @param session Claiming member.
 * @param claim Ids to confirm.
 * @param resume Continues the parked request.
 */
export function verifyAsk(
  core: ServerCore,
  room: Room,
  session: ConnectionSession,
  claim: VerifyClaim,
  resume: (outcome: ConnectionVerifyOutcome) => void,
): void {
  if (!session.verify.bucket.take(1) || !room.verifyBucket.take(1)) return resume('rate_limited');
  const query = room.verifyQueryNext();
  const timer = setTimeout(() => verifyFinish(core, session, query, 'owner_timeout'), core.config.verifyTimeoutMs);
  session.verify.pending = { room, query, timer, resume };
  room.verifyWaiting.set(query, session);
  const message: VerifyQueryMessage = { t: 'verify', q: query, ids: claim.ids, anc: claim.anc };
  sessionSend(room.owner, message);
}

/**
 * Takes the owner's answer to a query. Answers to queries that already timed
 * out are ignored. The owner's rate budget is refunded because the relay
 * asked.
 *
 * @param core Relay core.
 * @param session Sender, must be the owner.
 * @param message Answer.
 * @param bytes Frame size.
 */
export function handlerVerifyResult(
  core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'verify.result' }>,
  bytes: number,
): void {
  const room = session.room;
  if (room === null || room.owner !== session) return sessionSendError(session, 'not_owner', undefined);
  session.messageBucket.give(1);
  session.byteBucket.give(bytes);
  const member = room.verifyWaiting.get(message.q);
  if (member !== undefined) verifyFinish(core, member, message.q, message.v);
}

/**
 * Runs a lock or edit message now, or holds it behind the sender's open query
 * so a member's requests keep their order. Too many held messages close the
 * connection as rate limited.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Lock or edit message.
 * @param bytes Frame size.
 */
export function verifyHoldOrRun(
  core: ServerCore,
  session: ConnectionSession,
  message: ConnectionVerifyHeldMessage,
  bytes: number,
): void {
  if (session.verify.pending === null) return core.lockOrEditRoute(session, message);
  if (!session.verify.hold(message, bytes)) session.close(CLOSE_CODES.rateLimited, 'too many requests held');
}

/**
 * Ends a member's open query without an owner answer and drops its held
 * messages (the member left, or the room closed).
 *
 * @param session Member.
 * @param outcome Outcome reported to the parked request, or null to drop it.
 */
export function verifyCancel(session: ConnectionSession, outcome: ConnectionVerifyOutcome | null): void {
  session.verify.heldClear();
  const pending = session.verify.pending;
  if (pending === null) return;
  clearTimeout(pending.timer);
  pending.room.verifyWaiting.delete(pending.query);
  session.verify.pending = null;
  if (outcome !== null) pending.resume(outcome);
}

/**
 * Completes a query, resumes the parked request and then runs the messages held
 * behind it until one opens a new query.
 *
 * @param core Relay core.
 * @param session Member whose query ended.
 * @param query Query id.
 * @param outcome Outcome.
 */
function verifyFinish(
  core: ServerCore,
  session: ConnectionSession,
  query: number,
  outcome: ConnectionVerifyOutcome,
): void {
  const pending = session.verify.pending;
  if (pending === null || pending.query !== query) return;
  clearTimeout(pending.timer);
  pending.room.verifyWaiting.delete(query);
  session.verify.pending = null;
  if (outcome === 'invalid') session.verify.refuted++;
  pending.resume(outcome);
  verifyDrain(core, session);
}

/**
 * Runs held messages in order until none is left or one opens a new query.
 *
 * @param core Relay core.
 * @param session Member.
 */
function verifyDrain(core: ServerCore, session: ConnectionSession): void {
  while (session.verify.pending === null && !session.closed) {
    const next = session.verify.next();
    if (next === undefined) return;
    core.lockOrEditRoute(session, next);
  }
}
