/** Member-owned toy snapshots against a real local relay. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import {
  TOY_CLIENT_HEADER_BYTES,
  TOY_ENTRIES_MAXIMUM,
  TOY_ENTRY_FIXED_BYTES,
  TOY_PAYLOAD_BYTES_MAXIMUM,
  toyFrameRelay,
  TOY_TYPE_TENNIS_BALL,
  toyFrameDecode,
  toyFrameEncode,
  type ToyEntry,
} from '../../src/shared/toy_frame.ts';
import { BINARY_FRAME_KIND_TOY, CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration, TEST_DUMMY_FORWARDED_SECRET } from '../support/test_configuration.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';

const TOY_CAPS = ['select', 'toys'];
let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test, as if forwarded by the
 * trusted proxy for a client address (so abuse scores stay per test).
 *
 * @param caps Capabilities announced in hello.
 * @param address Client address the proxy reports.
 * @returns Connected client.
 */
async function connect(caps: string[] = TOY_CAPS, address = '127.0.0.1'): Promise<TestClient> {
  const headers = { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': address };
  const client = await TestClient.connect(port, { caps, headers });
  clients.push(client);
  return client;
}

/**
 * Creates a room with a toy-capable owner and synced members.
 *
 * @param memberCaps Capabilities of each member.
 * @param address Client address of the members.
 * @returns Owner, members and room id.
 */
async function roomWith(
  memberCaps: string[][] = [TOY_CAPS],
  address = '127.0.0.1',
): Promise<{ owner: TestClient; members: TestClient[]; roomId: string }> {
  const owner = await connect();
  const roomId = await roomCreate(owner);
  const members: TestClient[] = [];
  for (const caps of memberCaps) {
    const { joiner } = await testRoomJoinSynced(await connect(caps, address), owner, roomId);
    await owner.next('member.joined');
    members.push(joiner);
  }
  return { owner, members, roomId };
}

/**
 * Builds a toy entry of the sender whose opaque payload starts with a marker.
 *
 * @param x Marker (0..255), read back as the first payload byte.
 * @param id Toy id.
 * @param type Toy type.
 * @returns Entry.
 */
function ball(x: number, id = 1, type = TOY_TYPE_TENNIS_BALL): ToyEntry {
  const payload = new Uint8Array(7);
  payload[0] = x;
  return { type, id, flags: 0, position: [x, 0, 0], payload };
}

/**
 * Encodes a snapshot frame.
 *
 * @param entries Entries.
 * @param full Whether it lists every toy.
 * @returns Client frame.
 */
function frameOf(entries: ToyEntry[], full = true): Uint8Array {
  return toyFrameEncode({ full, tick: 1, bits: 9, origin: [0, 1, 0], entries });
}

/**
 * Collects the binary frames of one kind that arrive within a short window and
 * removes them from the inbox.
 *
 * @param client Receiving client.
 * @param kind Binary frame kind.
 * @param windowMs Collection window in milliseconds.
 * @returns Frames in arrival order.
 */
async function drain(client: TestClient, kind: number, windowMs = 150): Promise<Uint8Array[]> {
  await Bun.sleep(windowMs);
  /**
   * Tells whether an inbox item is a binary frame of the wanted kind.
   *
   * @param item Inbox item.
   * @returns True when it matches.
   */
  const matches = (item: (typeof client.inbox)[number]): boolean =>
    item.kind === 'binary' && (item as { data: Uint8Array }).data[1] === kind;
  const frames = client.inbox.filter(matches).map((item) => (item as { data: Uint8Array }).data);
  client.inbox.splice(0, client.inbox.length, ...client.inbox.filter((item) => !matches(item)));
  return frames;
}

/**
 * Collects snapshots and returns the first ball x of each.
 *
 * @param client Receiving client.
 * @param windowMs Collection window in milliseconds.
 * @returns Sender and first x (null for empty snapshots) per frame.
 */
async function snapshots(
  client: TestClient,
  windowMs = 150,
): Promise<{ sender: number; x: number | null; full?: boolean }[]> {
  return (await drain(client, BINARY_FRAME_KIND_TOY, windowMs)).map((frame) => {
    const decoded = toyFrameDecode(frame);
    const shown = { sender: decoded?.sender ?? 0, x: decoded?.entries[0]?.payload[0] ?? null };
    return decoded?.full === false ? { ...shown, full: false } : shown;
  });
}

/**
 * Reads the relay's abuse score of a connected room member.
 *
 * @param client Member.
 * @returns Score, or -1 when the member is not in a room.
 */
function scoreOf(client: TestClient): number {
  const sessions = [...server.core.registry.all()].flatMap((room) => [...room.members.values()]);
  return sessions.find((session) => session.user === client.user)?.limits.abuse.value() ?? -1;
}

/**
 * Builds a valid one-ball frame and lets a callback damage its bytes.
 *
 * @param damage Changes the frame in place.
 * @returns Damaged frame.
 */
function damaged(damage: (frame: Uint8Array, view: DataView) => void): Uint8Array {
  const frame = frameOf([ball(1, 1), ball(2, 2)]);
  damage(frame, new DataView(frame.buffer));
  return frame;
}

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({
      connectionsPerIp: 200,
      toysPerSecond: 10,
      toysBurst: 5,
      internalTestRoomsViaProxy: true,
    }),
  );
  port = server.port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

describe('toys capability', () => {
  test('is negotiated in hello and its limits are announced in welcome', async () => {
    const capable = await connect();
    const older = await connect(['select']);
    expect(capable.welcome.caps).toContain('toys');
    expect(older.welcome.caps).not.toContain('toys');
    expect(capable.welcome.limits).toMatchObject({ toysPerSecond: 10, toysPerMember: TOY_ENTRIES_MAXIMUM });
    expect(capable.welcome.limits).not.toHaveProperty('toyRequestsPerSecond');
  });
});

describe('toy snapshots', () => {
  test('any synced member publishes its own toys to every other capable member, stamped as sender', async () => {
    const { owner, members } = await roomWith([TOY_CAPS, TOY_CAPS, ['select']]);
    const [thrower, watcher, older] = members as [TestClient, TestClient, TestClient];
    thrower.sendRaw(frameOf([ball(3)]));
    expect(await snapshots(owner)).toEqual([{ sender: thrower.user, x: 3 }]);
    expect(await snapshots(watcher, 0)).toEqual([{ sender: thrower.user, x: 3 }]);
    expect(await drain(older, BINARY_FRAME_KIND_TOY, 0)).toEqual([]);
    expect(await drain(thrower, BINARY_FRAME_KIND_TOY, 0)).toEqual([]);
    owner.sendRaw(frameOf([ball(5)]));
    expect(await snapshots(thrower)).toEqual([{ sender: owner.user, x: 5 }]);
    expect(older.closeCode).toBeNull();
  });

  test('each member has its own rate; frames over it are dropped and the connection stays open', async () => {
    const { owner, members } = await roomWith([TOY_CAPS, TOY_CAPS], '198.51.100.1');
    const [first, second] = members as [TestClient, TestClient];
    for (let index = 0; index < 40; index++) first.sendRaw(frameOf([ball(index)]));
    second.sendRaw(frameOf([ball(100)]));
    const received = await snapshots(owner, 300);
    const fromFirst = received.filter((frame) => frame.sender === first.user);
    expect(fromFirst.length).toBeGreaterThan(0);
    expect(fromFirst.length).toBeLessThanOrEqual(8);
    expect(received).toContainEqual({ sender: second.user, x: 100 });
    expect(first.closeCode).toBeNull();
  });

  test('changes-only snapshots are relayed with their flag', async () => {
    const { owner, members } = await roomWith();
    const member = members[0] as TestClient;
    member.sendRaw(frameOf([ball(4)], false));
    expect(await snapshots(owner)).toEqual([{ sender: member.user, x: 4, full: false }]);
  });

  test('a member that finishes syncing gets the latest full snapshot of every member', async () => {
    const { owner, members, roomId } = await roomWith();
    const member = members[0] as TestClient;
    member.sendRaw(frameOf([ball(1)]));
    owner.sendRaw(frameOf([ball(7)]));
    await Bun.sleep(120);
    member.sendRaw(frameOf([ball(2)]));
    await Bun.sleep(120);
    member.sendRaw(frameOf([ball(3)], false));
    await Bun.sleep(120);
    const { joiner } = await testRoomJoinSynced(await connect(), owner, roomId);
    const caughtUp = await snapshots(joiner);
    expect(caughtUp).toHaveLength(2);
    expect(caughtUp).toContainEqual({ sender: member.user, x: 2 });
    expect(caughtUp).toContainEqual({ sender: owner.user, x: 7 });
    const { joiner: older } = await testRoomJoinSynced(await connect(['select']), owner, roomId);
    expect(await drain(older, BINARY_FRAME_KIND_TOY)).toEqual([]);
  });

  test("a leaver's latest snapshot is forgotten, so later joiners never see its toys", async () => {
    const { owner, members, roomId } = await roomWith();
    const member = members[0] as TestClient;
    member.sendRaw(frameOf([ball(1)]));
    await snapshots(owner);
    member.close();
    await owner.next('member.left');
    const { joiner } = await testRoomJoinSynced(await connect(), owner, roomId);
    expect(await snapshots(joiner)).toEqual([]);
  });
});

describe('toy violations', () => {
  test('malformed snapshots close the connection with 4001', async () => {
    const second = TOY_CLIENT_HEADER_BYTES + TOY_ENTRY_FIXED_BYTES + 7;
    const malformed = [
      new Uint8Array([0xa7, BINARY_FRAME_KIND_TOY, 1, 1, 0]),
      damaged((frame) => (frame[2] = 2)),
      damaged((frame) => (frame[3] = 1)),
      damaged((frame) => (frame[4] = 2)),
      damaged((frame) => (frame[second] = 0)),
      damaged((frame) => (frame[second + 1] = 1)),
      damaged((frame) => (frame[second + 1] = TOY_ENTRIES_MAXIMUM + 1)),
      damaged((frame) => (frame[second + 2] = 4)),
      damaged((frame) => (frame[second + 3] = 14)),
      damaged((frame) => (frame[second + 3] = 12)),
      frameOf([{ ...ball(1), payload: new Uint8Array(TOY_PAYLOAD_BYTES_MAXIMUM + 1) }]),
      damaged((_frame, view) => view.setFloat32(8, Number.POSITIVE_INFINITY)),
    ];
    for (const frame of malformed) {
      const client = await connect();
      client.sendRaw(frame);
      expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
    }
  });

  test('toy types the relay does not know pass through untouched', async () => {
    const { owner, members } = await roomWith();
    const member = members[0] as TestClient;
    const payload = Uint8Array.from({ length: TOY_PAYLOAD_BYTES_MAXIMUM }, (_value, index) => index);
    const strange = { ...ball(8, 2, 201), payload };
    member.sendRaw(frameOf([ball(3), strange]));
    const frames = await drain(owner, BINARY_FRAME_KIND_TOY);
    expect(frames).toHaveLength(1);
    expect(toyFrameDecode(frames[0] ?? new Uint8Array())?.entries).toEqual([ball(3), strange]);
    expect(member.closeCode).toBeNull();
  });

  test('a member cannot speak for someone else: a frame naming another sender is malformed', async () => {
    const { owner, members } = await roomWith([TOY_CAPS, TOY_CAPS]);
    const [spoofer, watcher] = members as [TestClient, TestClient];
    spoofer.sendRaw(toyFrameRelay(frameOf([ball(9)]), owner.user));
    expect(await spoofer.closed()).toBe(CLOSE_CODES.protocolViolation);
    watcher.sendRaw(frameOf([ball(4)]));
    expect(await snapshots(owner)).toEqual([{ sender: watcher.user, x: 4 }]);
  });

  test('a frame with more than four toys closes the connection', async () => {
    const { members } = await roomWith();
    const member = members[0] as TestClient;
    const five = frameOf([ball(1, 1), ball(2, 2), ball(3, 3), ball(4, 4)]);
    const tooMany = new Uint8Array(five.byteLength + TOY_ENTRY_FIXED_BYTES + 7);
    tooMany.set(five);
    tooMany[3] = 5;
    member.sendRaw(tooMany);
    expect(await member.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('toy frames without the capability close the connection', async () => {
    const { members } = await roomWith([['select']]);
    const member = members[0] as TestClient;
    member.sendRaw(frameOf([ball(1)]));
    expect(await member.closed()).toBe(CLOSE_CODES.protocolViolation);
  });
});

describe('toy floods', () => {
  test('frames over the rate score abuse points; past the throttle score nothing is relayed', async () => {
    const { owner, members } = await roomWith([TOY_CAPS], '198.51.100.2');
    const member = members[0] as TestClient;
    for (let index = 0; index < 30; index++) member.sendRaw(frameOf([ball(index)]));
    await snapshots(owner, 200);
    expect(scoreOf(member)).toBeGreaterThanOrEqual(server.core.config.abuseThrottleScore);
    await Bun.sleep(600);
    member.sendRaw(frameOf([ball(50)]));
    expect(await snapshots(owner)).toEqual([]);
    expect(member.closeCode).toBeNull();
  });

  test('a flood escalates to 4007, is flagged, and a reconnect carries half the throttle score', async () => {
    const { owner, members, roomId } = await roomWith([TOY_CAPS], '198.51.100.3');
    const member = members[0] as TestClient;
    for (let index = 0; index < 200 && member.closeCode === null; index++) member.sendRaw(frameOf([ball(index)]));
    expect(await member.closed()).toBe(CLOSE_CODES.abuse);
    expect(server.core.registry.get(roomId)?.abuseFlags.at(-1)).toMatchObject({ user: member.user, closed: true });
    await owner.next('member.left');
    const again = await connect(TOY_CAPS, '198.51.100.3');
    await roomCreate(again);
    const carried = scoreOf(again);
    expect(carried).toBeGreaterThan(server.core.config.abuseThrottleScore / 2 - 1);
    expect(carried).toBeLessThanOrEqual(server.core.config.abuseThrottleScore / 2);
  });

  test('toy frames count against the general message limit', async () => {
    const limited = collabServerStart(testConfiguration({ messagesPerSecond: 5, messageBurst: 10 }));
    const client = await TestClient.connect(limited.port, { caps: TOY_CAPS });
    await roomCreate(client);
    for (let index = 0; index < 20 && client.closeCode === null; index++) client.sendRaw(frameOf([ball(index)]));
    expect(await client.closed()).toBe(CLOSE_CODES.rateLimited);
    await limited.stop();
  });
});
