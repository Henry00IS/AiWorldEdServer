import { expect, test } from 'bun:test';
import { LimiterSharedBudget } from '../../../src/network/limiter_shared_budget.ts';
import { RoomLockTable } from '../../../src/rooms/room_lock_table.ts';

test('lock acquisition is all-or-nothing and reports holders', () => {
  const locks = new RoomLockTable(100, 1000);
  expect(locks.acquire(1, ['a', 'b'], false)).toEqual({ ok: true, added: ['a', 'b'], removed: [] });
  expect(locks.acquire(2, ['c', 'b'], false)).toEqual({
    ok: false,
    reason: 'lock_conflict',
    conflicts: [{ id: 'b', by: 1 }],
  });
  expect(locks.holderOf('c')).toBeUndefined();
  expect(locks.acquire(1, ['b', 'c'], true)).toEqual({ ok: true, added: ['c'], removed: ['a'] });
  expect(locks.acquire(2, ['a'], false).ok).toBe(true);
  expect(locks.release(1).sort()).toEqual(['b', 'c']);
  expect(locks.countFor(1)).toBe(0);
  expect(locks.countTotal()).toBe(1);
});

test('lock limits per user and per room', () => {
  const locks = new RoomLockTable(2, 3);
  expect(locks.acquire(1, ['a', 'b', 'c'], false)).toEqual({ ok: false, reason: 'lock_limit' });
  expect(locks.acquire(1, ['a', 'b'], false).ok).toBe(true);
  expect(locks.acquire(2, ['c', 'd'], false)).toEqual({ ok: false, reason: 'lock_limit' });
  expect(locks.acquire(1, ['x', 'y'], true).ok).toBe(true);
});

test('lock tables share the server-wide budget and return locks when released or closed', () => {
  const budget = new LimiterSharedBudget(5);
  const first = new RoomLockTable(100, 100, budget);
  const second = new RoomLockTable(100, 100, budget);
  expect(first.acquire(1, ['a', 'b', 'c'], false).ok).toBe(true);
  expect(second.acquire(2, ['d', 'e', 'f'], false)).toEqual({ ok: false, reason: 'lock_limit' });
  expect(second.acquire(2, ['d', 'e'], false).ok).toBe(true);
  expect(budget.inUse()).toBe(5);
  first.release(1, ['a']);
  expect(second.acquire(2, ['f'], false).ok).toBe(true);
  first.releaseEverything();
  expect(budget.inUse()).toBe(3);
  expect(first.countTotal()).toBe(0);
});
