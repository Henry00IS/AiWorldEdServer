import { expect, test } from 'bun:test';
import { ConnectionOutboundQueue } from '../../../src/connection/connection_outbound_queue.ts';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import { presenceFlush, presenceOffer, presencePurge } from '../../../src/handlers/handler_presence.ts';
import { Room } from '../../../src/rooms/room.ts';

/**
 * Creates a session with a fake socket whose buffer level the test controls.
 *
 * @param user User id of the session.
 * @returns Session, its socket and the frames it sent.
 */
function sessionFake(user: number) {
  const sent: Uint8Array[] = [];
  const socket = {
    buffered: 0,
    send: (data: string | Uint8Array) => (sent.push(data as Uint8Array), 1),
    getBufferedAmount: () => socket.buffered,
  };
  const outbound = new ConnectionOutboundQueue(socket, 1 << 20, 1000, () => {});
  const session = {
    user,
    ipKey: 'ip',
    name: `u${user}`,
    outbound,
    closed: false,
    synced: true,
    presencePending: new Map(),
    presenceHighWaterBytes: 100,
  } as unknown as ConnectionSession;
  outbound.idleListener = () => presenceFlush(session);
  return { session, socket, sent };
}

/**
 * Creates a small internal test room.
 *
 * @param owner Owner session.
 * @returns The room.
 */
function roomFake(owner: ConnectionSession): Room {
  return new Room({
    id: 'r',
    name: 'room',
    isPrivate: false,
    passwordHash: null,
    internalTest: true,
    maxUsers: 8,
    owner,
    locksPerUser: 10,
    locksPerRoom: 10,
  });
}

test('a busy recipient keeps only the latest frame per sender and gets it once idle', () => {
  const recipient = sessionFake(1);
  recipient.socket.buffered = 500;
  for (let index = 0; index < 50; index++) presenceOffer(recipient.session, 2, new Uint8Array([index]));
  presenceOffer(recipient.session, 3, new Uint8Array([99]));
  expect(recipient.sent.length).toBe(0);
  expect(recipient.session.presencePending.size).toBe(2);
  recipient.socket.buffered = 0;
  recipient.session.outbound.flush();
  expect(recipient.sent.map((frame) => frame[0])).toEqual([49, 99]);
  expect(recipient.session.presencePending.size).toBe(0);
});

test('presence waits behind queued edits and never enters the edit queue', () => {
  const recipient = sessionFake(1);
  recipient.socket.buffered = 5000;
  recipient.session.outbound.pushEdit('{"from":2,"seq":1,"ops":[]}');
  presenceOffer(recipient.session, 2, new Uint8Array([7]));
  expect(recipient.session.outbound.length()).toBe(1);
  recipient.socket.buffered = 0;
  recipient.session.outbound.flush();
  expect(typeof recipient.sent[0]).toBe('string');
  expect(recipient.sent[1]?.[0]).toBe(7);
});

test('purge forgets a leaver in every mailbox and in the room', () => {
  const owner = sessionFake(1);
  const other = sessionFake(2);
  const leaver = sessionFake(3);
  const room = roomFake(owner.session);
  room.memberAdd(other.session);
  other.socket.buffered = 500;
  presenceOffer(other.session, 3, new Uint8Array([1]));
  presenceOffer(other.session, 1, new Uint8Array([2]));
  room.presenceLatest.set(3, new Uint8Array([1]));
  room.memberDelete(3);
  presencePurge(room, leaver.session);
  expect([...other.session.presencePending.keys()]).toEqual([1]);
  expect(room.presenceLatest.has(3)).toBe(false);
});
