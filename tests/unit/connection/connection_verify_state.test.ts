import { expect, test } from 'bun:test';
import { ConnectionVerifyState } from '../../../src/connection/connection_verify_state.ts';

const limits = { perSecond: 1, burst: 2, heldMessagesMaximum: 2, heldBytesMaximum: 100 };

test('held messages come back in order and free their bytes', () => {
  const state = new ConnectionVerifyState(limits);
  expect(state.hold({ t: 'lock.release' }, 60)).toBe(true);
  expect(state.hold({ t: 'lock.acquire', lease: 1, ids: ['a'] }, 41)).toBe(false);
  expect(state.hold({ t: 'lock.acquire', lease: 1, ids: ['a'] }, 40)).toBe(true);
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

/** Binary frames consume the very same held-byte budget as scene edits. */
test('custom binary frames count toward held bytes and clear with the queue', () => {
  const state = new ConnectionVerifyState({ perSecond: 1, burst: 1, heldMessagesMaximum: 3, heldBytesMaximum: 40 });
  expect(state.hold({ t: 'lock.release' }, 20)).toBe(true);
  expect(state.hold(new Uint8Array(20), 20)).toBe(true);
  expect(state.hold(new Uint8Array(1), 1)).toBe(false);
  expect(state.next()).toEqual({ t: 'lock.release' });
  expect(state.next()).toEqual(new Uint8Array(20));
  state.heldClear();
  expect(state.hold(new Uint8Array(40), 40)).toBe(true);
});
