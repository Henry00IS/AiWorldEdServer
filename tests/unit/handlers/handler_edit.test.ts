/**
 * Unit tests for the edit lock check: creates may not take over ids other
 * members hold, exclusively or as an ancestor they share.
 */
import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { editClaim, editLockCheck } from '../../../src/handlers/handler_edit.ts';
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

test('a claim asks about chain heads and their ancestors once each', () => {
  const claim = editClaim([
    { k: 'reparent', ids: ['a'], d: {}, p: ['inner', 'middle', 'outer'] },
    { k: 'reparent', ids: ['b'], d: {}, p: ['middle', 'outer'] },
    { k: 'transform', ids: ['c'], d: {} },
    { k: 'reparent', ids: ['d'], d: {} },
  ] as never);
  expect(claim).toEqual({ ids: ['inner', 'middle'], anc: ['middle', 'outer'] });
});

test('a chain through a container created in the batch must repeat its chain', () => {
  const created = { k: 'create', ids: ['box', 'lid'], d: [{}, {}], p: ['group'] };
  const good = editClaim([created, { k: 'create', ids: ['x'], d: [{}], p: ['lid', 'group'] }] as never);
  expect(good).toEqual({ ids: ['group'], anc: [] });
  expect(editClaim([created, { k: 'reparent', ids: ['y'], d: {}, p: ['box'] }] as never)).toBeNull();
  const rootBox = { k: 'create', ids: ['box'], d: [{}] };
  expect(editClaim([rootBox, { k: 'reparent', ids: ['y'], d: {}, p: ['box'] }] as never)).toEqual({ ids: [], anc: [] });
});
