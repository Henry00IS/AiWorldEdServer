/**
 * Unit tests for shared (intent) locks: ancestors of edited objects can be
 * shared by several members but not taken exclusively by anybody else.
 */
import { expect, test } from 'bun:test';
import { LimiterSharedBudget } from '../../../src/network/limiter_shared_budget.ts';
import { RoomLockTable } from '../../../src/rooms/room_lock_table.ts';
import { RoomSharedLockTable } from '../../../src/rooms/room_shared_lock_table.ts';

test('shared lock table tracks several holders per id', () => {
  const shared = new RoomSharedLockTable();
  expect(shared.grant(1, ['a', 'b'])).toBe(2);
  expect(shared.grant(2, ['a'])).toBe(1);
  expect(shared.grant(1, ['a'])).toBe(0);
  expect(shared.otherHolder(1, 'a')).toBe(2);
  expect(shared.otherHolder(1, 'b')).toBeUndefined();
  expect(shared.countTotal()).toBe(3);
  expect(shared.release(2)).toBe(1);
  expect(shared.otherHolder(1, 'a')).toBeUndefined();
  expect(shared.countFor(1)).toBe(2);
  shared.clear();
  expect(shared.countTotal()).toBe(0);
});

test('an exclusive lock is refused on an ancestor another member shares', () => {
  const locks = new RoomLockTable(100, 1000);
  expect(locks.acquire(1, ['cube'], true, ['group']).ok).toBe(true);
  expect(locks.acquire(2, ['group', 'sphere'], true)).toEqual({
    ok: false,
    reason: 'lock_conflict',
    conflicts: [{ id: 'group', by: 1, shared: true }],
  });
  expect(locks.holderOf('group')).toBeUndefined();
  expect(locks.acquire(2, ['sphere'], true, ['group']).ok).toBe(true);
  expect(locks.listAll()).toEqual([
    { by: 1, ids: ['cube'] },
    { by: 2, ids: ['sphere'] },
  ]);
});

test('a shared lock is refused on an object another member holds exclusively', () => {
  const locks = new RoomLockTable(100, 1000);
  expect(locks.acquire(1, ['group', 'cube'], true).ok).toBe(true);
  expect(locks.acquire(2, ['other'], true, ['group'])).toEqual({
    ok: false,
    reason: 'lock_conflict',
    conflicts: [{ id: 'group', by: 1 }],
  });
  expect(locks.countFor(2)).toBe(0);
});

test('replace releases shared locks outside the request and release frees both kinds', () => {
  const locks = new RoomLockTable(100, 1000);
  locks.acquire(1, ['cube'], true, ['group', 'world']);
  expect(locks.countFor(1)).toBe(3);
  locks.acquire(1, ['cube'], true, ['world']);
  expect(locks.countFor(1)).toBe(2);
  expect(locks.acquire(2, ['group'], true).ok).toBe(true);
  expect(locks.release(1)).toEqual(['cube']);
  expect(locks.countFor(1)).toBe(0);
  expect(locks.acquire(2, ['world'], false).ok).toBe(true);
});

test('shared locks count against the per-user, per-room and server limits', () => {
  const budget = new LimiterSharedBudget(4);
  const locks = new RoomLockTable(3, 100, budget);
  expect(locks.acquire(1, ['a', 'b'], true, ['c', 'd'])).toEqual({ ok: false, reason: 'lock_limit' });
  expect(locks.acquire(1, ['a'], true, ['c', 'd']).ok).toBe(true);
  expect(budget.inUse()).toBe(3);
  expect(locks.acquire(2, ['x', 'y'], true)).toEqual({ ok: false, reason: 'lock_limit' });
  locks.releaseEverything();
  expect(budget.inUse()).toBe(0);
});

test('shared locks the sender already holds or owns are not planned twice', () => {
  const locks = new RoomLockTable(100, 1000);
  locks.acquire(1, ['group'], true, ['world']);
  expect(locks.sharedMissing(1, ['group', 'world', 'room', 'room'])).toEqual(['room']);
});
