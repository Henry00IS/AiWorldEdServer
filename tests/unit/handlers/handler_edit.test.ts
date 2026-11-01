/**
 * Unit tests for the edit lock check: creates may not take over ids other
 * members hold, exclusively or as an ancestor they share.
 */
import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { editLockCheck } from '../../../src/handlers/handler_edit.ts';
import { Room } from '../../../src/rooms/room.ts';

/**
 * Creates the minimal session a room needs for membership.
 *
 * @param user User id.
 * @returns Fake session.
 */
function session(user: number): ConnectionSession {
  return { user, ipKey: 'ip', name: `u${user}` } as unknown as ConnectionSession;
}

/**
 * Creates a room owned by user 1 with user 2 as a member.
 *
 * @returns Room.
 */
function roomFake(): Room {
  const room = new Room({
    id: 'r',
    name: 'room',
    isPrivate: false,
    passwordHash: null,
    internalTest: true,
    maxUsers: 8,
    owner: session(1),
    locksPerUser: 100,
    locksPerRoom: 100,
  });
  room.memberAdd(session(2));
  return room;
}

test('a create may not take over a container another member shares', () => {
  const room = roomFake();
  expect(room.locks.acquire(1, ['cube'], true, ['group']).ok).toBe(true);
  const plan = { created: [], deleted: [], shared: [] };
  const rejection = editLockCheck(room, 2, [{ k: 'create', ids: ['group'], d: [{}] }] as never, plan);
  expect(rejection).toEqual({ reason: 'lock_conflict', ids: ['group'] });
  expect(room.locks.holderOf('group')).toBeUndefined();
});

test('a create of a fresh id or one only the sender shares is accepted', () => {
  const room = roomFake();
  expect(room.locks.acquire(2, ['cube'], true, ['group']).ok).toBe(true);
  const plan = { created: [] as string[], deleted: [], shared: [] };
  expect(editLockCheck(room, 2, [{ k: 'create', ids: ['fresh', 'group'], d: [{}, {}] }] as never, plan)).toBeNull();
  expect(plan.created).toEqual(['fresh', 'group']);
});
