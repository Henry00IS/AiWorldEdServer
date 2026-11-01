import { expect, test } from 'bun:test';
import {
  ipLimitKey,
  requestTrustResolve,
  secretEqualsConstantTime,
} from '../../../src/network/trust_forwarded_request.ts';
import { TEST_DUMMY_FORWARDED_SECRET } from '../../support/test_configuration.ts';

/**
 * Builds request headers as the proxy would forward them.
 *
 * @param secret Forwarded secret header value, or null to omit it.
 * @param extra Extra or overriding headers.
 * @returns Request headers.
 */
function forwarded(secret: string | null, extra: Record<string, string> = {}): Headers {
  return new Headers({
    ...(secret === null ? {} : { 'x-forwarded-secret': secret }),
    'x-real-ip': '203.0.113.9',
    'x-forwarded-for': '198.51.100.1, 203.0.113.9',
    ...extra,
  });
}

/** Proxy trusted, secret required. */
const PROXY_WITH_SECRET = { trustProxy: true, forwardedSecret: TEST_DUMMY_FORWARDED_SECRET };
/** Proxy trusted, no secret. */
const PROXY_WITHOUT_SECRET = { trustProxy: true, forwardedSecret: null };
/** Default: no proxy. */
const DIRECT_ONLY = { trustProxy: false, forwardedSecret: null };

test('trust: without TRUST_PROXY every request is direct and forwarded headers are ignored', () => {
  expect(requestTrustResolve(forwarded(TEST_DUMMY_FORWARDED_SECRET), '192.0.2.5', DIRECT_ONLY)).toEqual({
    kind: 'direct',
    clientIp: '192.0.2.5',
  });
  expect(requestTrustResolve(forwarded('wrong'), '::ffff:127.0.0.1', DIRECT_ONLY)).toEqual({
    kind: 'direct',
    clientIp: '127.0.0.1',
  });
});

test('trust: with a required secret, no secret header is direct and ignores forwarded headers', () => {
  expect(requestTrustResolve(forwarded(null), '192.0.2.5', PROXY_WITH_SECRET)).toEqual({
    kind: 'direct',
    clientIp: '192.0.2.5',
  });
});

test('trust: correct secret uses X-Real-IP, then the last X-Forwarded-For hop, then the socket', () => {
  expect(requestTrustResolve(forwarded(TEST_DUMMY_FORWARDED_SECRET), '192.0.2.1', PROXY_WITH_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '203.0.113.9',
  });
  const headers = new Headers({
    'x-forwarded-secret': TEST_DUMMY_FORWARDED_SECRET,
    'x-forwarded-for': '1.1.1.1, 198.51.100.7',
  });
  expect(requestTrustResolve(headers, '192.0.2.1', PROXY_WITH_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '198.51.100.7',
  });
  const garbage = new Headers({ 'x-forwarded-secret': TEST_DUMMY_FORWARDED_SECRET, 'x-real-ip': 'not-an-ip' });
  expect(requestTrustResolve(garbage, '192.0.2.1', PROXY_WITH_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '192.0.2.1',
  });
});

test('trust: a wrong or empty secret is rejected when a secret is required', () => {
  expect(requestTrustResolve(forwarded('wrong'), '192.0.2.1', PROXY_WITH_SECRET).kind).toBe('rejected');
  expect(requestTrustResolve(forwarded(''), '192.0.2.1', PROXY_WITH_SECRET).kind).toBe('rejected');
  expect(secretEqualsConstantTime('abc', 'abc')).toBe(true);
  expect(secretEqualsConstantTime('abc', 'abcd')).toBe(false);
});

test('trust: TRUST_PROXY without a secret believes forwarded headers and ignores any secret header', () => {
  expect(requestTrustResolve(forwarded(null), '192.0.2.1', PROXY_WITHOUT_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '203.0.113.9',
  });
  expect(requestTrustResolve(forwarded('anything'), '192.0.2.1', PROXY_WITHOUT_SECRET).kind).toBe('proxied');
  expect(requestTrustResolve(new Headers(), '::ffff:192.0.2.1', PROXY_WITHOUT_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '192.0.2.1',
  });
});

test('IPv6 addresses share a /64 limit key', () => {
  expect(ipLimitKey('2001:db8:1:2:aaaa::1')).toBe(ipLimitKey('2001:db8:1:2:bbbb::2'));
  expect(ipLimitKey('2001:db8:1:2::1')).not.toBe(ipLimitKey('2001:db8:1:3::1'));
  expect(ipLimitKey('203.0.113.9')).toBe('203.0.113.9');
});
