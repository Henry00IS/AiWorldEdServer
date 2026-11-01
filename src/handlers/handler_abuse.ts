/**
 * Abuse scoring: protocol misuse that an honest editor never produces (a second
 * operation while one runs, edits outside the running operation, renewal or
 * acquire floods, oversized lease requests) earns points. Points decay; past
 * the throttle score lock, edit and select requests are refused, past the
 * disconnect score the connection is closed with code 4007, flagged in its room
 * for the owner and kept out of that room for a while.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { ServerCore } from '../server/server_core.ts';
import { CLOSE_CODES } from '../shared/protocol_definitions.ts';

/**
 * Adds misuse points to a session and throttles or closes it when it crosses
 * the configured scores.
 *
 * @param core Relay core.
 * @param session Offender.
 * @param points Weight of the misuse.
 * @param reason Short description for the flag and close frame.
 */
export function abuseRecord(core: ServerCore, session: ConnectionSession, points: number, reason: string): void {
  if (points <= 0 || session.closed) return;
  const before = session.limits.abuse.value();
  const after = session.limits.abuse.add(points);
  const { abuseThrottleScore, abuseDisconnectScore } = core.config;
  if (after >= abuseDisconnectScore) return abuseClose(core, session, reason);
  if (before < abuseThrottleScore && after >= abuseThrottleScore) abuseFlag(session, reason, false);
}

/**
 * Reports whether the session's score is above the throttle score, so lock,
 * edit and select requests are refused with `throttled`.
 *
 * @param core Relay core.
 * @param session Sender.
 * @returns True while the session is throttled.
 */
export function abuseThrottled(core: ServerCore, session: ConnectionSession): boolean {
  return session.limits.abuse.value() >= core.config.abuseThrottleScore;
}

/**
 * Closes an abusive session, flags it in its room and starts the room's join
 * cooldown for its address.
 *
 * @param core Relay core.
 * @param session Offender.
 * @param reason Short description.
 */
function abuseClose(core: ServerCore, session: ConnectionSession, reason: string): void {
  abuseFlag(session, reason, true);
  session.room?.joinCooldownSet(session.ipKey, performance.now() + core.config.abuseRoomCooldownMs);
  console.warn(`abuse: closed user ${session.user} in room ${session.room?.id ?? '-'}: ${reason}`);
  session.close(CLOSE_CODES.abuse, `abuse: ${reason}`.slice(0, 120));
}

/**
 * Remembers an abuse flag in the session's room, if any.
 *
 * @param session Offender.
 * @param reason Short description.
 * @param closed Whether the connection was closed.
 */
function abuseFlag(session: ConnectionSession, reason: string, closed: boolean): void {
  session.room?.abuseFlag({ user: session.user, name: session.name, reason, closed });
}
