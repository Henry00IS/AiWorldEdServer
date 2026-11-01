import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../src/connection/connection_session.ts';
import { Room } from '../../src/rooms/room.ts';
import { RoomLockTable } from '../../src/rooms/room_lock_table.ts';
import { RoomRegistry } from '../../src/rooms/room_registry.ts';

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

test('color slots: lowest free slot, unique among members, reused after leaving', () => {
  const session = (user: number) => ({ user, ipKey: 'ip', name: `u${user}` }) as unknown as ConnectionSession;
  const room = new Room({
    id: 'r',
    name: 'room',
    isPrivate: false,
    passwordHash: null,
    internalTest: true,
    maxUsers: 8,
    owner: session(1),
    locksPerUser: 10,
    locksPerRoom: 10,
  });
  for (const user of [2, 3, 4]) room.memberAdd(session(user));
  expect([1, 2, 3, 4].map((user) => room.colorOf(user))).toEqual([0, 1, 2, 3]);
  room.memberDelete(2);
  room.memberDelete(3);
  room.memberAdd(session(5));
  room.memberAdd(session(6));
  room.memberAdd(session(7));
  expect([5, 6, 7].map((user) => room.colorOf(user))).toEqual([1, 2, 4]);
  expect(new Set(room.memberList().map((entry) => entry.color)).size).toBe(room.members.size);
});
