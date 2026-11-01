/**
 * Decides whether an upgrade request came through the trusted reverse proxy and
 * which client address it represents.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Header the reverse proxy adds with the shared secret. */
export const HEADER_FORWARDED_SECRET = 'x-forwarded-secret';

/** Trust verdict for an incoming request. */
export type RequestTrust =
  { kind: 'direct'; clientIp: string } | { kind: 'proxied'; clientIp: string } | { kind: 'rejected'; reason: string };

/** Settings that decide whether forwarded client addresses are believed. */
export interface RequestTrustPolicy {
  /** Whether a reverse proxy sits in front and its address headers are believed. */
  readonly trustProxy: boolean;
  /** Secret the proxy must present, or null when none is required. */
  readonly forwardedSecret: string | null;
}

/**
 * Resolves trust and client address.
 *
 * - Without TRUST_PROXY: direct, the socket address is the client and every
 *   forwarded header is ignored.
 * - TRUST_PROXY with a secret: no secret header is a direct connection (socket
 *   address); the correct secret is proxied (X-Real-IP, else the last
 *   X-Forwarded-For hop); a wrong secret is rejected.
 * - TRUST_PROXY without a secret: every request is proxied.
 *
 * @param headers Request headers.
 * @param socketAddress Remote address of the TCP peer.
 * @param policy Proxy trust settings.
 * @returns Trust verdict.
 */
export function requestTrustResolve(headers: Headers, socketAddress: string, policy: RequestTrustPolicy): RequestTrust {
  if (!policy.trustProxy) return { kind: 'direct', clientIp: ipNormalize(socketAddress) };
  const proxied: RequestTrust = { kind: 'proxied', clientIp: forwardedClientIp(headers) ?? ipNormalize(socketAddress) };
  if (policy.forwardedSecret === null) return proxied;
  const presentedSecret = headers.get(HEADER_FORWARDED_SECRET);
  if (presentedSecret === null) return { kind: 'direct', clientIp: ipNormalize(socketAddress) };
  if (!secretEqualsConstantTime(presentedSecret, policy.forwardedSecret))
    return { kind: 'rejected', reason: 'forwarded secret mismatch' };
  return proxied;
}

/**
 * Compares two secrets in constant time by comparing fixed-length digests.
 *
 * @param presented Secret from the request.
 * @param expected Configured secret.
 * @returns True when equal.
 */
export function secretEqualsConstantTime(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Reads the client address that the trusted proxy forwarded.
 *
 * @param headers Request headers from the trusted proxy.
 * @returns Client address from X-Real-IP, else the last X-Forwarded-For hop,
 *   else null.
 */
function forwardedClientIp(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp && isIP(ipNormalize(realIp))) return ipNormalize(realIp);
  const forwardedHops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const lastHop = forwardedHops[forwardedHops.length - 1];
  if (lastHop && isIP(ipNormalize(lastHop))) return ipNormalize(lastHop);
  return null;
}

/**
 * Removes the IPv4-mapped IPv6 prefix and lower-cases the address.
 *
 * @param address Raw address.
 * @returns Normalized address.
 */
export function ipNormalize(address: string): string {
  const lowered = address.trim().toLowerCase();
  return lowered.startsWith('::ffff:') && isIP(lowered.slice(7)) === 4 ? lowered.slice(7) : lowered;
}

/**
 * Key used for per-address limits: the IPv4 address, or the /64 prefix of an
 * IPv6 address (one subscriber usually owns a whole /64).
 *
 * @param address Normalized address.
 * @returns Limit key.
 */
export function ipLimitKey(address: string): string {
  if (isIP(address) !== 6) return address;
  return `${ipv6Expand(address).slice(0, 4).join(':')}::/64`;
}

/**
 * Expands an IPv6 address into eight hextets.
 *
 * @param address IPv6 address.
 * @returns Eight lower-case hextets.
 */
function ipv6Expand(address: string): string[] {
  const [head = '', tail = ''] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = address.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const zeros = address.includes('::') ? Array.from({ length: Math.max(0, missing) }, () => '0') : [];
  return [...headParts, ...zeros, ...tailParts].map((part) => part.replace(/^0+(?=.)/, ''));
}
