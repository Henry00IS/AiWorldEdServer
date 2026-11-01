import { expect, test } from 'bun:test';
import { LimiterKeyCounter } from '../../../src/network/limiter_key_counter.ts';

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
