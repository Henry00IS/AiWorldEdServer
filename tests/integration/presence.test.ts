/** Presence relay, display names and color slots against a real local relay. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { presenceFrameDecode, presenceFrameEncode, type PresenceEntry } from '../../src/shared/presence_frame.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';

let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test.
 *
 * @param name Optional display name sent with hello.
 * @returns Connected client.
 */
async function connect(name?: string): Promise<TestClient> {
  const client = await TestClient.connect(port, name ? { name } : {});
  clients.push(client);
  return client;
}

/**
 * Builds a camera presence entry at a given x position.
 *
 * @param x Camera x position.
 * @returns Presence entry.
 */
function camera(x: number): PresenceEntry {
  return { id: 0, position: [x, 1, 2], quaternion: [0, 0, 0, 1], fov: 50 };
}

/**
 * Creates a room with an owner and one synced member.
 *
 * @returns Owner, member and room id.
 */
async function roomPair(): Promise<{ owner: TestClient; member: TestClient; roomId: string }> {
  const owner = await connect('Owner');
  const roomId = await roomCreate(owner);
  const { joiner } = await testRoomJoinSynced(await connect('Member'), owner, roomId);
  await owner.next('member.joined');
  return { owner, member: joiner, roomId };
}

/**
 * Collects every presence frame that arrives within a short window and removes
 * them from the inbox.
 *
 * @param client Receiving client.
 * @param windowMs Collection window in milliseconds.
 * @returns Sender and first camera x of every frame.
 */
async function presenceDrain(client: TestClient, windowMs = 150): Promise<{ sender: number; x: number | null }[]> {
  await Bun.sleep(windowMs);
  const frames = client.inbox
    .filter((item) => item.kind === 'binary')
    .map((item) => presenceFrameDecode((item as { data: Uint8Array }).data));
  client.inbox.splice(0, client.inbox.length, ...client.inbox.filter((item) => item.kind !== 'binary'));
  return frames.map((frame) => ({ sender: frame?.sender ?? 0, x: frame?.entries[0]?.position[0] ?? null }));
}

beforeAll(() => {
  server = collabServerStart(testConfiguration({ connectionsPerIp: 200, presencePerSecond: 10, presenceBurst: 5 }));
  port = server.port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

/**
 * Creates an internal test room with a display name for the owner.
 *
 * @param owner Creating client.
 * @param displayName Requested display name.
 * @returns The creation reply.
 */
function roomCreateNamed(owner: TestClient, displayName: string): Promise<TestMessage> {
  return owner.request(
    { t: 'room.create', name: 'colors', private: false, internalTest: true, displayName },
    'room.created',
  );
}

/**
 * Joins a room with a display name without receiving the snapshot.
 *
 * @param client Joining client.
 * @param roomId Room id.
 * @param displayName Requested display name.
 * @returns The join reply.
 */
function roomJoinNamed(client: TestClient, roomId: string, displayName: string): Promise<TestMessage> {
  return client.request({ t: 'room.join', room: roomId, discardLocalWork: true, displayName }, 'room.joined');
}

/**
 * Lists the name and color of every member of a join reply, sorted.
 *
 * @param joined Join reply.
 * @returns Sorted name and color pairs.
 */
function memberNameColors(joined: TestMessage): [string, number][] {
  return joined.members.map((member: { name: string; color: number }) => [member.name, member.color]).sort();
}

describe('names and colors', () => {
  test('display names from create and join, lowest free color slots in every event', async () => {
    const owner = await connect('Old Name');
    const created = await roomCreateNamed(owner, ' Alice ');
    expect(created).toMatchObject({ name: 'Alice', color: 0 });
    const bob = await connect();
    await testRoomJoinSynced(bob, owner, created.room.id, undefined, { displayName: 'Bob' });
    expect(await owner.next('member.joined')).toMatchObject({ user: bob.user, name: 'Bob', color: 1 });
    const carol = await connect();
    const joined = await roomJoinNamed(carol, created.room.id, 'Carol');
    expect(memberNameColors(joined)).toEqual([
      ['Alice', 0],
      ['Bob', 1],
      ['Carol', 2],
    ]);
    bob.close();
    await owner.next('member.left');
    const dave = await connect();
    await roomJoinNamed(dave, created.room.id, 'Dave');
    expect(await owner.next('member.joined', (message) => message.user === dave.user)).toMatchObject({ color: 1 });
  });

  test('invalid display names are rejected; long hello names are cut and missing ones fall back', async () => {
    const owner = await connect('a very long display name');
    expect(owner.welcome.name).toBe('a very long');
    const anonymous = await connect();
    expect(anonymous.welcome.name).toBe(`User ${anonymous.user % 10_000_000}`);
    const reply = await owner.request(
      { t: 'room.create', name: 'x', private: false, internalTest: true, displayName: 'thirteen char' },
      'room.created',
    );
    expect(reply).toMatchObject({ t: 'error', code: 'invalid_name', reason: 'too_long', field: 'displayName' });
    const roomId = await roomCreate(owner);
    const join = await anonymous.request(
      { t: 'room.join', room: roomId, discardLocalWork: true, displayName: '   ' },
      'room.joined',
    );
    expect(join).toMatchObject({ t: 'error', code: 'invalid_name', field: 'displayName' });
  });
});

describe('presence', () => {
  test('relayed to the other members with the sender id, never echoed', async () => {
    const { owner, member } = await roomPair();
    member.sendRaw(presenceFrameEncode([camera(3)]));
    expect(await presenceDrain(owner)).toEqual([{ sender: member.user, x: 3 }]);
    expect(await presenceDrain(member, 0)).toEqual([]);
  });

  test('over the presence rate frames are dropped silently, the connection stays open', async () => {
    const { owner, member } = await roomPair();
    for (let index = 0; index < 40; index++) member.sendRaw(presenceFrameEncode([camera(index)]));
    const received = await presenceDrain(owner, 300);
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(8);
    expect(member.closeCode).toBeNull();
  });

  test('rooms are isolated and members who are not synced yet cannot send', async () => {
    const first = await roomPair();
    const second = await roomPair();
    const pending = await connect();
    await pending.request({ t: 'room.join', room: first.roomId, discardLocalWork: true }, 'room.joined');
    pending.sendRaw(presenceFrameEncode([camera(9)]));
    second.member.sendRaw(presenceFrameEncode([camera(5)]));
    expect(await presenceDrain(first.owner)).toEqual([]);
    expect(await presenceDrain(first.member, 0)).toEqual([]);
    expect(await presenceDrain(second.owner, 0)).toEqual([{ sender: second.member.user, x: 5 }]);
  });

  test('a member that finishes syncing gets the latest presence; a leaver is forgotten', async () => {
    const { owner, member, roomId } = await roomPair();
    member.sendRaw(presenceFrameEncode([camera(1)]));
    await Bun.sleep(150);
    member.sendRaw(presenceFrameEncode([camera(2)]));
    owner.sendRaw(presenceFrameEncode([camera(7)]));
    await Bun.sleep(100);
    const { joiner } = await testRoomJoinSynced(await connect(), owner, roomId);
    expect((await presenceDrain(joiner)).sort((a, b) => a.sender - b.sender)).toEqual(
      [
        { sender: owner.user, x: 7 },
        { sender: member.user, x: 2 },
      ].sort((a, b) => a.sender - b.sender),
    );
    member.close();
    await owner.next('member.left');
    const { joiner: late } = await testRoomJoinSynced(await connect(), owner, roomId);
    expect(await presenceDrain(late)).toEqual([{ sender: owner.user, x: 7 }]);
  });

  test('malformed presence frames close the connection', async () => {
    const { member } = await roomPair();
    member.sendRaw(new Uint8Array([0xa7, 2, 1, 1, 0]));
    expect(await member.closed()).toBe(CLOSE_CODES.protocolViolation);
  });
});
