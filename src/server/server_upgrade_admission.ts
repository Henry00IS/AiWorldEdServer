/**
 * Decides whether a WebSocket upgrade is admitted and, if not, which close code
 * and reason tell the client why.
 */
import type { ConnectionUpgradeData } from '../connection/connection_session.ts';
import { originIsAllowed } from '../network/origin_policy.ts';
import { ipLimitKey, requestTrustResolve } from '../network/trust_forwarded_request.ts';
import { CLOSE_CODES } from '../shared/protocol_definitions.ts';
import type { ServerCore } from './server_core.ts';

/** Why an upgrade was refused, as sent to the client. */
export interface UpgradeRefusal {
  /** WebSocket close code from CLOSE_CODES. */
  readonly code: number;
  /** Close reason, at most 123 bytes of printable ASCII. */
  readonly reason: string;
  /** HTTP status used when the refusal cannot be sent as a close frame. */
  readonly httpStatus: number;
}

/** Outcome of the upgrade checks. */
export type UpgradeAdmission =
  { kind: 'admitted'; data: ConnectionUpgradeData } | { kind: 'refused'; refusal: UpgradeRefusal };

/** Longest part of a refused Origin echoed in the close reason. */
const UPGRADE_REFUSAL_ORIGIN_LENGTH_MAXIMUM = 96;

/**
 * Turns an untrusted Origin header into printable ASCII short enough for a
 * close reason.
 *
 * @param origin Origin header value or null.
 * @returns Displayable origin.
 */
export function upgradeRefusalOriginText(origin: string | null): string {
  if (origin === null || origin === '') return '(none)';
  return origin.replace(/[^\x21-\x7e]/g, '?').slice(0, UPGRADE_REFUSAL_ORIGIN_LENGTH_MAXIMUM);
}

/**
 * Applies proxy trust, the Origin allow list and the connection limits, in that
 * order. Only an admitted upgrade reserves a connection slot.
 *
 * @param core Relay core.
 * @param headers Upgrade request headers.
 * @param socketAddress Remote address of the TCP peer.
 * @returns Admission with socket data, or the refusal.
 */
export function upgradeAdmissionDecide(core: ServerCore, headers: Headers, socketAddress: string): UpgradeAdmission {
  const trust = requestTrustResolve(headers, socketAddress, core.config);
  if (trust.kind === 'rejected')
    return upgradeRefused(CLOSE_CODES.proxyRefused, 'proxy refused: X-Forwarded-Secret does not match', 403);
  const origin = headers.get('origin');
  if (!originIsAllowed(origin, core.config.allowedOrigins))
    return upgradeRefused(CLOSE_CODES.originRefused, `origin not allowed: ${upgradeRefusalOriginText(origin)}`, 403);
  const ipKey = ipLimitKey(trust.clientIp);
  if (!core.connectionReserve(ipKey)) return upgradeRefusedForConnections(core);
  const via = trust.kind === 'proxied' ? 'proxy' : 'direct';
  return { kind: 'admitted', data: { clientIp: trust.clientIp, ipKey, via } };
}

/**
 * Builds the refusal for a full relay or an address with too many connections.
 *
 * @param core Relay core.
 * @returns Refusal naming which limit was hit.
 */
function upgradeRefusedForConnections(core: ServerCore): UpgradeAdmission {
  if (core.connectionsFull()) return upgradeRefused(CLOSE_CODES.serverFull, 'server full', 503);
  return upgradeRefused(CLOSE_CODES.tooManyConnections, 'too many connections from your address', 429);
}

/**
 * Builds a refusal outcome.
 *
 * @param code Close code.
 * @param reason Close reason.
 * @param httpStatus HTTP status for the fallback response.
 * @returns Refused admission.
 */
function upgradeRefused(code: number, reason: string, httpStatus: number): UpgradeAdmission {
  return { kind: 'refused', refusal: { code, reason, httpStatus } };
}
