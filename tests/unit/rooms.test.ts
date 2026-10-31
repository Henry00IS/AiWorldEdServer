import { expect, test } from 'bun:test';
import { RoomLockTable } from '../../src/rooms/room_lock_table.ts';
import { RoomRegistry } from '../../src/rooms/room_registry.ts';

test('lock acquisition is all-or-nothing and reports holders', () => {
  const locks = new RoomLockTable(100, 1000);
  expect(locks.acquire(1, ['a', 'b'], false)).toEqual({ ok: true, added: ['a', 'b'], removed: [] });
  expect(locks.acquire(2, ['c', 'b'], false)).toEqual({ ok: false, reason: 'lock_conflict', conflicts: [{ id: 'b', by: 1 }] });
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

test('registry enforces per-IP and total room limits with reservations', () => {
  const registry = new RoomRegistry(2, 3);
  expect(registry.reserve('ip1')).toBe('ok');
  expect(registry.reserve('ip1')).toBe('ok');
  expect(registry.reserve('ip1')).toBe('room_limit_ip');
  expect(registry.reserve('ip2')).toBe('ok');
  expect(registry.reserve('ip3')).toBe('room_limit_server');
  registry.reservationCancel('ip1');
  expect(registry.reserve('ip1')).toBe('ok');
});
