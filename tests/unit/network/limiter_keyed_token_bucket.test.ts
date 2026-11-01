import { expect, test } from 'bun:test';
import { LimiterKeyedTokenBucket } from '../../../src/network/limiter_keyed_token_bucket.ts';

test('keyed token bucket limits each key separately and refills over time', () => {
  let now = 0;
  const limiter = new LimiterKeyedTokenBucket(1, 3, () => now);
  for (let index = 0; index < 3; index++) expect(limiter.take('a')).toBe(true);
  expect(limiter.take('a')).toBe(false);
  expect(limiter.take('b')).toBe(true);
  now += 1000;
  expect(limiter.take('a')).toBe(true);
  expect(limiter.take('a')).toBe(false);
});

test('keyed token bucket forgets fully refilled keys when pruned', () => {
  let now = 0;
  const limiter = new LimiterKeyedTokenBucket(1, 2, () => now);
  limiter.take('a');
  limiter.take('b', 2);
  expect(limiter.keyCount()).toBe(2);
  now += 1000;
  limiter.prune();
  expect(limiter.keyCount()).toBe(1);
  now += 1000;
  limiter.prune();
  expect(limiter.keyCount()).toBe(0);
});
