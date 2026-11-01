import { expect, test } from 'bun:test';
import { ConnectionVerifyState } from '../../../src/connection/connection_verify_state.ts';

const limits = { perSecond: 1, burst: 2, heldMessagesMaximum: 2, heldBytesMaximum: 100 };

test('held messages come back in order and free their bytes', () => {
  const state = new ConnectionVerifyState(limits);
  expect(state.hold({ t: 'lock.release' }, 60)).toBe(true);
  expect(state.hold({ t: 'lock.acquire', ids: ['a'] }, 41)).toBe(false);
  expect(state.hold({ t: 'lock.acquire', ids: ['a'] }, 40)).toBe(true);
  expect(state.hold({ t: 'lock.release' }, 1)).toBe(false);
  expect(state.next()).toEqual({ t: 'lock.release' });
  expect(state.hold({ t: 'lock.release' }, 60)).toBe(true);
  expect(state.heldCount()).toBe(2);
  state.heldClear();
  expect(state.next()).toBeUndefined();
});

test('a new state is idle, unrefuted and has its full query burst', () => {
  const state = new ConnectionVerifyState(limits);
  expect([state.pending, state.refuted]).toEqual([null, 0]);
  expect([state.bucket.take(), state.bucket.take(), state.bucket.take()]).toEqual([true, true, false]);
});
