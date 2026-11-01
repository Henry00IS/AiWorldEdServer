import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { Room } from '../../../src/rooms/room.ts';

/**
 * Creates the minimal session a room needs for membership.
 *
 * @param user User id.
 * @returns Fake session.
 */
function sessionFake(user: number): ConnectionSession {
  return { user, ipKey: 'ip', name: `u${user}` } as unknown as ConnectionSession;
}

test('color slots: lowest free slot, unique among members, reused after leaving', () => {
  const room = new Room({
    id: 'r',
    name: 'room',
    isPrivate: false,
    passwordHash: null,
    internalTest: true,
    maxUsers: 8,
    owner: sessionFake(1),
    locksPerUser: 10,
    locksPerRoom: 10,
  });
  for (const user of [2, 3, 4]) room.memberAdd(sessionFake(user));
  expect([1, 2, 3, 4].map((user) => room.colorOf(user))).toEqual([0, 1, 2, 3]);
  room.memberDelete(2);
  room.memberDelete(3);
  room.memberAdd(sessionFake(5));
  room.memberAdd(sessionFake(6));
  room.memberAdd(sessionFake(7));
  expect([5, 6, 7].map((user) => room.colorOf(user))).toEqual([1, 2, 4]);
  expect(new Set(room.memberList().map((entry) => entry.color)).size).toBe(room.members.size);
});

test('verify query ids count up from 1 and skip ids that are still open', () => {
  const room = new Room({
    id: 'r',
    name: 'room',
    isPrivate: false,
    passwordHash: null,
    internalTest: true,
    maxUsers: 8,
    owner: sessionFake(1),
    locksPerUser: 10,
    locksPerRoom: 10,
  });
  expect(room.verifyQueryNext()).toBe(1);
  room.verifyWaiting.set(2, sessionFake(2));
  expect(room.verifyQueryNext()).toBe(3);
});
