import { expect, test } from 'bun:test';
import { LimiterTokenBucket } from '../../../src/network/limiter_token_bucket.ts';

test('token bucket refills over time', () => {
  let now = 0;
  const bucket = new LimiterTokenBucket(10, 5, () => now);
  for (let index = 0; index < 5; index++) expect(bucket.take()).toBe(true);
  expect(bucket.take()).toBe(false);
  now += 200;
  expect(bucket.take(2)).toBe(true);
  expect(bucket.take()).toBe(false);
});
