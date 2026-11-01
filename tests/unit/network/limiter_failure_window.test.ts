import { expect, test } from 'bun:test';
import { LimiterFailureWindow } from '../../../src/network/limiter_failure_window.ts';

test('failure window blocks after N failures until the window passes', () => {
  let now = 0;
  const window = new LimiterFailureWindow(3, 60_000, () => now);
  for (let index = 0; index < 3; index++) window.recordFailure('ip');
  expect(window.isBlocked('ip')).toBe(true);
  expect(window.isBlocked('other')).toBe(false);
  now += 60_001;
  expect(window.isBlocked('ip')).toBe(false);
});
