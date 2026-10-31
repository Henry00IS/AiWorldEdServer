/**
 * Decides whether an upgrade request came through the trusted reverse proxy
 * and which client address it represents.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Header the reverse proxy adds with the shared secret. */
export const HEADER_FORWARDED_SECRET = 'x-forwarded-secret';

/** Trust verdict for an incoming request. */
export type RequestTrust =
  | { kind: 'direct'; clientIp: string }
  | { kind: 'proxied'; clientIp: string }
  | { kind: 'rejected'; reason: string };

/**
 * Resolves trust and client address.
 * - No secret header: direct connection, socket address is used, forwarded headers are ignored.
 * - Correct secret: proxied, X-Real-IP (or the last X-Forwarded-For hop) is the client.
 * - Wrong secret, or a secret header while none is configured: rejected.
 *
 * @param headers Request headers.
 * @param socketAddress Remote address of the TCP peer.
 * @param configuredSecret Expected secret, or null when the proxy is not configured.
 * @returns Trust verdict.
 */
export function requestTrustResolve(headers: Headers, socketAddress: string, configuredSecret: string | null): RequestTrust {
  const presentedSecret = headers.get(HEADER_FORWARDED_SECRET);
  if (presentedSecret === null) return { kind: 'direct', clientIp: ipNormalize(socketAddress) };
  if (configuredSecret === null || !secretEqualsConstantTime(presentedSecret, configuredSecret)) {
    return { kind: 'rejected', reason: 'forwarded secret mismatch' };
  }
  return { kind: 'proxied', clientIp: forwardedClientIp(headers) ?? ipNormalize(socketAddress) };
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
 * @param headers Request headers from the trusted proxy.
 * @returns Client address from X-Real-IP, else the last X-Forwarded-For hop, else null.
 */
function forwardedClientIp(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp && isIP(ipNormalize(realIp))) return ipNormalize(realIp);
  const forwardedHops = (headers.get('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
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
