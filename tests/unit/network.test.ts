import { expect, test } from 'bun:test';
import { LimiterFailureWindow } from '../../src/network/limiter_failure_window.ts';
import { LimiterKeyCounter } from '../../src/network/limiter_key_counter.ts';
import { LimiterTokenBucket } from '../../src/network/limiter_token_bucket.ts';
import { originIsAllowed } from '../../src/network/origin_policy.ts';
import {
  ipLimitKey,
  requestTrustResolve,
  secretEqualsConstantTime,
} from '../../src/network/trust_forwarded_request.ts';
import { ALLOWED_ORIGINS_DEFAULT } from '../../src/config/server_configuration.ts';
import { TEST_DUMMY_FORWARDED_SECRET } from '../support/test_configuration.ts';

const forwarded = (secret: string | null, extra: Record<string, string> = {}) =>
  new Headers({
    ...(secret === null ? {} : { 'x-forwarded-secret': secret }),
    'x-real-ip': '203.0.113.9',
    'x-forwarded-for': '198.51.100.1, 203.0.113.9',
    ...extra,
  });

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

test('origin allow list', () => {
  expect(originIsAllowed('https://henry00is.github.io', ALLOWED_ORIGINS_DEFAULT)).toBe(true);
  expect(originIsAllowed('http://localhost:5173', ALLOWED_ORIGINS_DEFAULT)).toBe(true);
  expect(originIsAllowed('http://localhost.evil.com:5173', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed('https://evil.example', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed('null', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed(null, ALLOWED_ORIGINS_DEFAULT)).toBe(false);
});

test('token bucket refills over time', () => {
  let now = 0;
  const bucket = new LimiterTokenBucket(10, 5, () => now);
  for (let index = 0; index < 5; index++) expect(bucket.take()).toBe(true);
  expect(bucket.take()).toBe(false);
  now += 200;
  expect(bucket.take(2)).toBe(true);
  expect(bucket.take()).toBe(false);
});

test('key counter caps concurrent resources per key', () => {
  const counter = new LimiterKeyCounter(2);
  expect(counter.tryAcquire('a')).toBe(true);
  expect(counter.tryAcquire('a')).toBe(true);
  expect(counter.tryAcquire('a')).toBe(false);
  expect(counter.tryAcquire('b')).toBe(true);
  counter.release('a');
  expect(counter.count('a')).toBe(1);
  expect(counter.tryAcquire('a')).toBe(true);
});

test('failure window blocks after N failures until the window passes', () => {
  let now = 0;
  const window = new LimiterFailureWindow(3, 60_000, () => now);
  for (let index = 0; index < 3; index++) window.recordFailure('ip');
  expect(window.isBlocked('ip')).toBe(true);
  expect(window.isBlocked('other')).toBe(false);
  now += 60_001;
  expect(window.isBlocked('ip')).toBe(false);
});
