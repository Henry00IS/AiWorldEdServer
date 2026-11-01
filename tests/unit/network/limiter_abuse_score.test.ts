/**
 * Unit tests for misuse scores: linear decay, and the per-address carry that
 * keeps a reconnecting abuser from starting clean.
 */
import { expect, test } from 'bun:test';
import { LimiterAbuseCarry, LimiterAbuseScore } from '../../../src/network/limiter_abuse_score.ts';

test('a score decays linearly and never drops below zero', () => {
  let now = 0;
  const score = new LimiterAbuseScore(2, 0, () => now);
  expect(score.add(10)).toBe(10);
  now = 2000;
  expect(score.value()).toBe(6);
  now = 10_000;
  expect(score.value()).toBe(0);
});

test('a new session inherits the closed session score up to a cap', () => {
  let now = 0;
  const carry = new LimiterAbuseCarry(1, 10, () => now);
  const first = carry.sessionScore('ip');
  first.add(50);
  carry.sessionClosed('ip', first);
  expect(carry.sessionScore('ip', 10).value()).toBe(10);
  expect(carry.sessionScore('other', 10).value()).toBe(0);
  now = 60_000;
  carry.prune();
  expect(carry.keyCount()).toBe(0);
});

test('a lower score does not lower the carried one and the key count is capped', () => {
  const carry = new LimiterAbuseCarry(0, 2, () => 0);
  const high = new LimiterAbuseScore(0, 30, () => 0);
  carry.sessionClosed('ip', high);
  carry.sessionClosed('ip', new LimiterAbuseScore(0, 5, () => 0));
  expect(carry.sessionScore('ip').value()).toBe(30);
  carry.sessionClosed('b', high);
  carry.sessionClosed('c', high);
  expect(carry.keyCount()).toBe(2);
  expect(carry.sessionScore('ip').value()).toBe(0);
});
