/**
 * Room chat and room-unique display names: limits, normalization, ordering, no
 * history, isolation, numbered names and the rename lock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate, snapshotSend, streamReceive, testRoomJoinSynced } from '../support/test_room.ts';

const CHAT_INTERVAL_MS = 300;
let server: CollabServer;
const clients: TestClient[] = [];

beforeAll(() => {
  server = collabServerStart(testConfiguration({ connectionsPerIp: 200, chatIntervalMs: CHAT_INTERVAL_MS }));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects a tracked client that is closed after each test.
 *
 * @param name Display name sent in hello.
 * @returns Connected client.
 */
async function connect(name?: string): Promise<TestClient> {
  const client = await TestClient.connect(server.port, name === undefined ? {} : { name });
  clients.push(client);
  return client;
}

/**
 * Creates a room owned by a new client and joins further clients to it.
 *
 * @param names Display names; the first one owns the room.
 * @returns Room id and the clients in join order.
 */
async function roomWith(...names: string[]): Promise<{ roomId: string; members: TestClient[] }> {
  const owner = await connect(names[0]);
  const roomId = await roomCreate(owner);
  const members = [owner];
  for (const name of names.slice(1)) {
    const member = await connect(name);
    await testRoomJoinSynced(member, owner, roomId);
    members.push(member);
  }
  return { roomId, members };
}

/**
 * Sends one chat message and waits for its acknowledgement or error.
 *
 * @param client Sender.
 * @param text Message text.
 * @returns The `chat.sent` reply or an error.
 */
function chatSend(client: TestClient, text: string): Promise<TestMessage> {
  return client.request({ t: 'chat', text }, 'chat.sent');
}

/**
 * Joins a room with a display name and returns the reply.
 *
 * @param client Joining client.
 * @param owner Room owner that answers the snapshot request.
 * @param roomId Room id.
 * @param displayName Requested display name.
 * @returns The `room.joined` reply.
 */
async function joinNamed(client: TestClient, owner: TestClient, roomId: string, displayName?: string) {
  const extra = displayName === undefined ? {} : { displayName };
  const reply = await client.request({ t: 'room.join', room: roomId, discardLocalWork: true, ...extra }, 'room.joined');
  await snapshotSend(owner, new TextEncoder().encode('{}'));
  await streamReceive(client);
  return reply;
}

describe('chat', () => {
  test('welcome advertises the chat limits', async () => {
    const client = await connect('Limits');
    expect(client.welcome.limits).toMatchObject({
      chatIntervalMs: CHAT_INTERVAL_MS,
      chatTextLength: 2000,
      chatTextLines: 20,
    });
  });

  test('a message reaches every member with sender, name, color and server time', async () => {
    const { members } = await roomWith('Alice', 'Bob', 'Carol');
    const [alice, bob, carol] = members as [TestClient, TestClient, TestClient];
    const before = Date.now();
    const sent = await chatSend(alice, 'hello room');
    const entry = { id: 1, from: alice.user, name: 'Alice', color: 0, text: 'hello room' };
    expect(sent).toMatchObject({ t: 'chat.sent', ...entry });
    expect(sent.at).toBeGreaterThanOrEqual(before - 1000);
    for (const receiver of [bob, carol]) {
      expect(await receiver.next('chat')).toEqual({ t: 'chat', ...entry, at: sent.at });
    }
    await Bun.sleep(50);
    expect(alice.has('chat')).toBe(false);
  });

  test('messages from several senders arrive in id order', async () => {
    const { members } = await roomWith('A', 'B', 'C', 'D');
    const [a, b, c, d] = members as [TestClient, TestClient, TestClient, TestClient];
    expect((await chatSend(a, 'one')).id).toBe(1);
    expect((await chatSend(b, 'two')).id).toBe(2);
    expect((await chatSend(c, 'three')).id).toBe(3);
    const texts = [];
    for (let index = 0; index < 3; index++) texts.push((await d.next('chat')).text);
    expect(texts).toEqual(['one', 'two', 'three']);
  });

  test('one message per interval, with a retry-after that is honoured', async () => {
    const { members } = await roomWith('Fast', 'Peer');
    const [fast, peer] = members as [TestClient, TestClient];
    expect((await chatSend(fast, 'first')).t).toBe('chat.sent');
    const limited = await chatSend(fast, 'second');
    expect(limited).toMatchObject({ t: 'error', code: 'chat_rate_limited' });
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(CHAT_INTERVAL_MS);
    expect((await chatSend(peer, 'others are not limited')).t).toBe('chat.sent');
    await Bun.sleep(limited.retryAfterMs + 20);
    expect((await chatSend(fast, 'third')).t).toBe('chat.sent');
    expect((await peer.next('chat')).text).toBe('first');
    expect((await peer.next('chat')).text).toBe('third');
  });

  test('length, line and emptiness limits reject without spending the interval', async () => {
    const { members } = await roomWith('Writer', 'Reader');
    const [writer, reader] = members as [TestClient, TestClient];
    const tooMany = Array.from({ length: 21 }, (_, index) => `${index}`).join('\n');
    expect(await chatSend(writer, 'x'.repeat(2001))).toMatchObject({ code: 'invalid_chat', reason: 'too_long' });
    expect(await chatSend(writer, tooMany)).toMatchObject({ code: 'invalid_chat', reason: 'too_many_lines' });
    expect(await chatSend(writer, '\u200B\u202E \n')).toMatchObject({ code: 'invalid_chat', reason: 'empty' });
    expect((await chatSend(writer, '😀'.repeat(2000))).t).toBe('chat.sent');
    expect((await reader.next('chat')).text).toBe('😀'.repeat(2000));
  });

  test('text is normalized and markup is passed on verbatim as text', async () => {
    const { members } = await roomWith('Sender', 'Viewer');
    const [sender, viewer] = members as [TestClient, TestClient];
    const markup = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    expect((await chatSend(sender, `  ${markup}\u202E\u200B\r\n\n\n\nok\u0007  `)).text).toBe(`${markup}\n\nok`);
    expect((await viewer.next('chat')).text).toBe(`${markup}\n\nok`);
  });

  test('chat outside a room, malformed chat and oversized frames are refused', async () => {
    const loner = await connect('Loner');
    expect(await chatSend(loner, 'anyone?')).toMatchObject({ t: 'error', code: 'not_in_room' });
    const { members } = await roomWith('Bad');
    const [bad] = members as [TestClient];
    bad.send({ t: 'chat', text: 'x'.repeat(8193) });
    expect(await bad.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('late joiners get no history', async () => {
    const { roomId, members } = await roomWith('Early');
    const [early] = members as [TestClient];
    await chatSend(early, 'before you came');
    const late = await connect('Late');
    await testRoomJoinSynced(late, early, roomId);
    await Bun.sleep(CHAT_INTERVAL_MS);
    await chatSend(early, 'welcome');
    const message = await late.next('chat');
    expect(message).toMatchObject({ id: 2, text: 'welcome' });
    await Bun.sleep(50);
    expect(late.has('chat')).toBe(false);
  });

  test('rooms are isolated and leavers stop receiving', async () => {
    const first = await roomWith('One', 'Two');
    const second = await roomWith('Three', 'Four');
    const [one, two] = first.members as [TestClient, TestClient];
    const [three, four] = second.members as [TestClient, TestClient];
    expect((await chatSend(one, 'room one')).id).toBe(1);
    expect((await chatSend(three, 'room two')).id).toBe(1);
    expect((await two.next('chat')).text).toBe('room one');
    expect((await four.next('chat')).text).toBe('room two');
    await two.request({ t: 'room.leave' }, 'room.left');
    await Bun.sleep(CHAT_INTERVAL_MS);
    await chatSend(one, 'gone?');
    await Bun.sleep(80);
    for (const client of [two, three, four]) expect(client.has('chat')).toBe(false);
  });
});

describe('room-unique names', () => {
  test('a taken name gets the lowest free number, case-insensitively', async () => {
    const owner = await connect('Henry');
    const roomId = await roomCreate(owner);
    const second = await connect('Henry');
    const third = await connect('HENRY');
    expect((await joinNamed(second, owner, roomId, 'Henry')).name).toBe('Henry2');
    expect((await owner.next('member.joined')).name).toBe('Henry2');
    const joined = await joinNamed(third, owner, roomId, 'HENRY');
    expect(joined).toMatchObject({ name: 'HENRY3', color: 2 });
    expect(joined.members.map((member: { name: string }) => member.name).sort()).toEqual(
      ['Henry', 'Henry2', 'HENRY3'].sort(),
    );
    expect((await chatSend(third, 'hi')).name).toBe('HENRY3');
    await second.request({ t: 'room.leave' }, 'room.left');
    const fourth = await connect('henry');
    expect((await joinNamed(fourth, owner, roomId, 'henry')).name).toBe('henry2');
  });

  test('numbered names stay within 12 characters', async () => {
    const owner = await connect('Bartholomew1');
    const roomId = await roomCreate(owner);
    const joiner = await connect('Bartholomew1');
    expect((await joinNamed(joiner, owner, roomId, 'Bartholomew1')).name).toBe('Bartholomew2');
  });

  test('the creator gets its own name and color in room.created', async () => {
    const owner = await connect('Solo');
    const created = await owner.request(
      { t: 'room.create', name: 'solo', private: false, internalTest: true },
      'room.created',
    );
    expect(created).toMatchObject({ name: 'Solo', color: 0 });
  });

  test('names are locked inside a room and free again outside', async () => {
    const owner = await connect('Owner');
    const roomId = await roomCreate(owner);
    const member = await connect('Owner');
    expect((await joinNamed(member, owner, roomId, 'Owner')).name).toBe('Owner2');
    expect(await member.request({ t: 'name.set', name: 'Mallory' }, 'name.changed')).toMatchObject({
      t: 'error',
      code: 'name_locked',
    });
    expect(await owner.request({ t: 'name.set', name: 'Boss' }, 'name.changed')).toMatchObject({ code: 'name_locked' });
    await member.request({ t: 'room.leave' }, 'room.left');
    expect(await member.request({ t: 'name.set', name: 'Mallory' }, 'name.changed')).toMatchObject({
      t: 'name.changed',
      name: 'Mallory',
    });
    expect(await member.request({ t: 'name.set', name: 'x'.repeat(13) }, 'name.changed')).toMatchObject({
      code: 'invalid_name',
    });
    const other = await roomWith('Other');
    expect((await joinNamed(member, other.members[0] as TestClient, other.roomId)).name).toBe('Mallory');
  });
});
