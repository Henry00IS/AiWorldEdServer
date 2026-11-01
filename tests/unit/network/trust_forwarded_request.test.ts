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

test('trust: no secret header is direct and ignores forwarded headers', () => {
  expect(requestTrustResolve(forwarded(null), '192.0.2.5', TEST_DUMMY_FORWARDED_SECRET)).toEqual({
    kind: 'direct',
    clientIp: '192.0.2.5',
  });
  expect(requestTrustResolve(forwarded(null), '::ffff:127.0.0.1', null)).toEqual({
    kind: 'direct',
    clientIp: '127.0.0.1',
  });
});

test('trust: correct secret uses X-Real-IP, then the last X-Forwarded-For hop', () => {
  expect(requestTrustResolve(forwarded(TEST_DUMMY_FORWARDED_SECRET), '192.0.2.1', TEST_DUMMY_FORWARDED_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '203.0.113.9',
  });
  const headers = new Headers({
    'x-forwarded-secret': TEST_DUMMY_FORWARDED_SECRET,
    'x-forwarded-for': '1.1.1.1, 198.51.100.7',
  });
  expect(requestTrustResolve(headers, '192.0.2.1', TEST_DUMMY_FORWARDED_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '198.51.100.7',
  });
  const garbage = new Headers({ 'x-forwarded-secret': TEST_DUMMY_FORWARDED_SECRET, 'x-real-ip': 'not-an-ip' });
  expect(requestTrustResolve(garbage, '192.0.2.1', TEST_DUMMY_FORWARDED_SECRET)).toEqual({
    kind: 'proxied',
    clientIp: '192.0.2.1',
  });
});

test('trust: wrong secret or unconfigured secret is rejected', () => {
  expect(requestTrustResolve(forwarded('wrong'), '192.0.2.1', TEST_DUMMY_FORWARDED_SECRET).kind).toBe('rejected');
  expect(requestTrustResolve(forwarded(''), '192.0.2.1', TEST_DUMMY_FORWARDED_SECRET).kind).toBe('rejected');
  expect(requestTrustResolve(forwarded(TEST_DUMMY_FORWARDED_SECRET), '192.0.2.1', null).kind).toBe('rejected');
  expect(secretEqualsConstantTime('abc', 'abc')).toBe(true);
  expect(secretEqualsConstantTime('abc', 'abcd')).toBe(false);
});

test('IPv6 addresses share a /64 limit key', () => {
  expect(ipLimitKey('2001:db8:1:2:aaaa::1')).toBe(ipLimitKey('2001:db8:1:2:bbbb::2'));
  expect(ipLimitKey('2001:db8:1:2::1')).not.toBe(ipLimitKey('2001:db8:1:3::1'));
  expect(ipLimitKey('203.0.113.9')).toBe('203.0.113.9');
});
