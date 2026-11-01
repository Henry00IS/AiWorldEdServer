/**
 * End-to-end tests against a real local relay over real WebSockets. Rooms use
 * the internal test flag, which is only accepted from direct (non-proxied)
 * connections. The forwarded secret is a dummy value from the test config.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { binaryFrameEncode } from '../../src/shared/binary_frame.ts';
import { CLOSE_CODES, PROTOCOL_ID, PROTOCOL_VERSION } from '../../src/shared/protocol_definitions.ts';
import { passwordGenerate } from '../../src/shared/password_generator.ts';
import { testSocketOutcome } from '../support/test_socket_outcome.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { roomCreate, snapshotSend, streamReceive, testRoomJoinSynced } from '../support/test_room.ts';
import { TEST_DUMMY_FORWARDED_SECRET, TEST_ORIGIN, testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test.
 *
 * @param options Connection options.
 * @returns Connected client.
 */
async function connect(options: Parameters<typeof TestClient.connect>[1] = {}): Promise<TestClient> {
  const client = await TestClient.connect(port, options);
  clients.push(client);
  return client;
}

/**
 * Builds headers that look like a request forwarded by the proxy with the dummy
 * secret.
 *
 * @param clientIp Forwarded client address.
 * @returns Request headers.
 */
function proxiedHeaders(clientIp: string): Record<string, string> {
  return { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': clientIp, 'X-Forwarded-For': clientIp };
}

/**
 * Connects a new client, joins the room and receives the full snapshot.
 *
 * @param owner Room owner that answers the snapshot request.
 * @param roomId Room id.
 * @param snapshot Snapshot bytes the owner sends.
 * @returns The joiner and the received snapshot bytes.
 */
async function joinSynced(
  owner: TestClient,
  roomId: string,
  snapshot?: Uint8Array,
): Promise<{ joiner: TestClient; received: Uint8Array }> {
  return testRoomJoinSynced(await connect(), owner, roomId, snapshot);
}

/**
 * Requests a public room without the internal test flag.
 *
 * @param owner Creating client.
 * @param name Room name.
 * @returns The creation reply.
 */
function roomCreatePublic(owner: TestClient, name: string): Promise<TestMessage> {
  return owner.request({ t: 'room.create', name, private: false }, 'room.created');
}

/**
 * Requests to join a room, optionally with a password, without receiving the
 * snapshot.
 *
 * @param joiner Joining client.
 * @param roomId Room id.
 * @param password Room password, if any.
 * @returns The join reply.
 */
function roomJoinWithPassword(joiner: TestClient, roomId: string, password?: string): Promise<TestMessage> {
  return joiner.request(
    { t: 'room.join', room: roomId, discardLocalWork: true, ...(password === undefined ? {} : { password }) },
    'room.joined',
  );
}

/**
 * Receives relayed edits until a number of them arrived, checking the sender.
 *
 * @param recipient Receiving client.
 * @param from Expected sender user id.
 * @param count Number of edits to collect.
 * @returns Sequence numbers in arrival order.
 */
async function editSequencesReceive(recipient: TestClient, from: number, count: number): Promise<number[]> {
  const seen: number[] = [];
  while (seen.length < count) {
    const frame = await recipient.next('edits');
    for (const entry of frame.list) {
      expect(entry.from).toBe(from);
      seen.push(entry.seq);
    }
  }
  return seen;
}

/**
 * Sends a texture asset from the owner as one single-chunk stream.
 *
 * @param owner Room owner.
 * @param to Recipient user id.
 * @param bytes Asset bytes.
 */
function assetStreamSend(owner: TestClient, to: number, bytes: Uint8Array): void {
  owner.send({
    t: 'stream.begin',
    to,
    stream: 9,
    kind: 'asset',
    size: bytes.length,
    name: 'textures/wall.png',
    mime: 'image/png',
  });
  owner.sendRaw(binaryFrameEncode(9, to, bytes));
  owner.send({ t: 'stream.end', to, stream: 9 });
}

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({
      handshakeTimeoutMs: 300,
      connectionsPerIp: 200,
      joinFailuresPerIpPerMinute: 1000,
      joinFailuresPerRoomPerMinute: 3,
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

describe('handshake and gatekeeping', () => {
  test('hello yields welcome with limits; direct connections report via=direct', async () => {
    const client = await connect({ name: '  Tester  ' });
    expect(client.welcome).toMatchObject({
      protocol: PROTOCOL_ID,
      version: PROTOCOL_VERSION,
      via: 'direct',
      name: 'Tester',
    });
    expect(client.welcome.limits.roomsPerIp).toBe(8);
    expect(client.welcome.limits.presencePerSecond).toBe(10);
    client.send({ t: 'ping', r: 5 });
    expect((await client.next('pong')).r).toBe(5);
  });

  test('upgrade is refused without an allowed Origin and with a wrong forwarded secret', async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    expect((await testSocketOutcome(url, { headers: {} })).code).toBe(CLOSE_CODES.originRefused);
    expect((await testSocketOutcome(url, { headers: { Origin: 'https://evil.example' } })).code).toBe(
      CLOSE_CODES.originRefused,
    );
    const wrongSecret = { Origin: TEST_ORIGIN, 'X-Forwarded-Secret': 'wrong-secret' };
    expect((await testSocketOutcome(url, { headers: wrongSecret })).code).toBe(CLOSE_CODES.proxyRefused);
    const emptySecret = { Origin: TEST_ORIGIN, 'X-Forwarded-Secret': '' };
    expect((await testSocketOutcome(url, { headers: emptySecret })).code).toBe(CLOSE_CODES.proxyRefused);
  });

  test('plain HTTP: health check and 404 elsewhere', async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok\n');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(426);
  });

  test.each([
    ['garbage text', 'GET / HTTP/1.1'],
    ['unknown type', JSON.stringify({ t: 'proxy.connect', host: 'example.com' })],
    ['message before hello', JSON.stringify({ t: 'room.list' })],
    ['version out of range', JSON.stringify({ t: 'hello', protocol: PROTOCOL_ID, version: 70000, client: 'x' })],
    ['binary before hello', new Uint8Array([1, 2, 3])],
  ])('protocol violation closes the socket: %s', async (_label, payload) => {
    const client = await connect({ hello: false });
    client.sendRaw(payload);
    expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('unknown fields after the handshake close the socket', async () => {
    const client = await connect();
    client.send({ t: 'room.list', extra: true });
    expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('silent clients are dropped after the handshake timeout', async () => {
    const client = await connect({ hello: false });
    expect(await client.closed(2000)).toBe(CLOSE_CODES.handshakeTimeout);
  });

  test('frames above the maximum payload size are refused', async () => {
    const client = await connect();
    client.sendRaw('x'.repeat(2 * 1024 * 1024));
    expect(await client.closed()).not.toBe(1000);
  });
});

describe('rooms', () => {
  test('create, list and join a public room; the owner is asked for a snapshot', async () => {
    const owner = await connect({ name: 'Owner' });
    const roomId = await roomCreate(owner);
    const viewer = await connect();
    const list = await viewer.request({ t: 'room.list' }, 'room.list');
    const entry = list.rooms.find((room: { id: string }) => room.id === roomId);
    expect(entry).toMatchObject({ private: false, users: 1 });
    const { joiner, received } = await joinSynced(owner, roomId);
    expect(new TextDecoder().decode(received)).toBe('{"world":1}');
    expect((await owner.next('member.joined')).user).toBe(joiner.user);
  });

  test('room names are validated', async () => {
    const owner = await connect();
    const tooLong = await owner.request(
      { t: 'room.create', name: 'x'.repeat(129), private: false, internalTest: true },
      'room.created',
    );
    expect(tooLong).toMatchObject({ t: 'error', code: 'invalid_name' });
    const control = await owner.request(
      { t: 'room.create', name: 'bad\u0007', private: false, internalTest: true },
      'room.created',
    );
    expect(control).toMatchObject({ t: 'error', code: 'invalid_name' });
  });

  test('private rooms require a strong password', async () => {
    const owner = await connect();
    for (const weak of ['00000000', 'Password1!', 'Abcd1234!x']) {
      const reply = await owner.request(
        { t: 'room.create', name: 'secret', private: true, password: weak, internalTest: true },
        'room.created',
      );
      expect(reply).toMatchObject({ t: 'error', code: 'weak_password' });
    }
  });

  test('private rooms hide and verify the password', async () => {
    const owner = await connect();
    const password = passwordGenerate();
    const roomId = await roomCreate(owner, { private: true, password });
    const list = await owner.request({ t: 'room.list' }, 'room.list');
    const entry = list.rooms.find((room: { id: string }) => room.id === roomId);
    expect(entry.private).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(password);

    const joiner = await connect();
    expect(await roomJoinWithPassword(joiner, roomId)).toMatchObject({ code: 'password_required' });
    expect(await roomJoinWithPassword(joiner, roomId, 'Wrong-Pass9!')).toMatchObject({ code: 'wrong_password' });
    expect((await roomJoinWithPassword(joiner, roomId, password)).t).toBe('room.joined');
  });

  test('wrong passwords are rate limited per room', async () => {
    const owner = await connect();
    const password = passwordGenerate();
    const roomId = await roomCreate(owner, { private: true, password });
    const joiner = await connect();
    for (let attempt = 0; attempt < 3; attempt++) {
      await joiner.request(
        { t: 'room.join', room: roomId, discardLocalWork: true, password: 'Wrong-Pass9!' },
        'room.joined',
      );
    }
    const blocked = await joiner.request(
      { t: 'room.join', room: roomId, discardLocalWork: true, password },
      'room.joined',
    );
    expect(blocked).toMatchObject({ t: 'error', code: 'too_many_attempts' });
  });

  test('joining requires discarding local work explicitly', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const joiner = await connect();
    joiner.send({ t: 'room.join', room: roomId });
    expect(await joiner.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('owner disconnect warns members about the offline session and closes the room', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    owner.close();
    const closed = await joiner.next('room.closed');
    expect(closed).toMatchObject({ reason: 'owner_left', offline: true });
    expect(closed.message).toContain('save your changes locally');
    const rejoin = await (
      await connect()
    ).request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    expect(rejoin).toMatchObject({ t: 'error', code: 'room_not_found' });
  });

  test('at most 8 owned rooms per IP address', async () => {
    const owners: TestClient[] = [];
    for (let index = 0; index < 8; index++) {
      const owner = await connect({ headers: proxiedHeaders('198.51.100.20') });
      expect((await roomCreatePublic(owner, `limit ${index}`)).t).toBe('room.created');
      owners.push(owner);
    }
    const ninth = await connect({ headers: proxiedHeaders('198.51.100.20') });
    expect(await roomCreatePublic(ninth, 'limit 9')).toMatchObject({ code: 'room_limit_ip' });
    const otherIp = await connect({ headers: proxiedHeaders('198.51.100.21') });
    expect((await roomCreatePublic(otherIp, 'other ip')).t).toBe('room.created');
    (owners[0] as TestClient).close();
    await Bun.sleep(50);
    expect((await roomCreatePublic(ninth, 'limit 9')).t).toBe('room.created');
    for (const owner of owners) owner.close();
    ninth.close();
    otherIp.close();
  });

  test('forwarded headers are ignored without the secret', async () => {
    const spoofed = await connect({ headers: { 'X-Real-IP': '203.0.113.50', 'X-Forwarded-For': '203.0.113.50' } });
    expect(spoofed.welcome.via).toBe('direct');
  });
});

describe('internal test flag', () => {
  test('proxied connections (dummy secret) are reported as proxy and cannot create or see test rooms', async () => {
    const direct = await connect();
    const hiddenRoom = await roomCreate(direct);
    const proxied = await connect({ headers: proxiedHeaders('203.0.113.77') });
    expect(proxied.welcome.via).toBe('proxy');
    const create = await proxied.request(
      { t: 'room.create', name: 'sneaky', private: false, internalTest: true },
      'room.created',
    );
    expect(create).toMatchObject({ t: 'error', code: 'internal_test_forbidden' });
    const list = await proxied.request({ t: 'room.list' }, 'room.list');
    expect(list.rooms.some((room: { id: string }) => room.id === hiddenRoom)).toBe(false);
    const join = await proxied.request({ t: 'room.join', room: hiddenRoom, discardLocalWork: true }, 'room.joined');
    expect(join).toMatchObject({ t: 'error', code: 'room_not_found' });
  });
});

describe('locks and edits', () => {
  test('locks are exclusive, atomic, and report the holder', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    expect(await owner.request({ t: 'lock.acquire', ids: ['a', 'b'] }, 'lock.result')).toMatchObject({
      ok: true,
      add: ['a', 'b'],
    });
    expect((await joiner.next('locks')).add).toEqual(['a', 'b']);
    const rejected = await joiner.request({ t: 'lock.acquire', ids: ['c', 'b'] }, 'lock.result');
    expect(rejected).toMatchObject({ ok: false, code: 'lock_conflict', conflicts: [{ id: 'b', by: owner.user }] });
    expect(await owner.request({ t: 'lock.acquire', ids: ['c'] }, 'lock.result')).toMatchObject({ ok: true });
    await owner.request({ t: 'lock.release', ids: ['b'] }, 'lock.result');
    expect(await joiner.request({ t: 'lock.acquire', ids: ['b'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('locks are freed when a member disconnects', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    await joiner.request({ t: 'lock.acquire', ids: ['x1', 'x2'] }, 'lock.result');
    await owner.next('locks');
    joiner.close();
    const freed = await owner.next('locks', (message) => message.by === joiner.user && Array.isArray(message.remove));
    expect(freed.remove.sort()).toEqual(['x1', 'x2']);
    expect(await owner.request({ t: 'lock.acquire', ids: ['x1'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('one-shot edits need no lock, are relayed in order and acknowledged in the edit stream', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner: first } = await joinSynced(owner, roomId);
    const { joiner: second } = await joinSynced(owner, roomId);
    for (let seq = 1; seq <= 5; seq++)
      first.send({ t: 'edit', seq, ops: [{ k: 'property', ids: ['cube'], d: { f: { name: `n${seq}` } } }] });
    for (const recipient of [owner, second]) {
      expect(await editSequencesReceive(recipient, first.user, 5)).toEqual([1, 2, 3, 4, 5]);
    }
    const acks = await editSequencesReceive(first, first.user, 5);
    expect(acks).toEqual([1, 2, 3, 4, 5]);
  });

  test('a one-shot edit is refused only while another member leases the object', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    await owner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'property', ids: ['cube'], d: { f: { name: 'x' } } }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'lock_conflict', ids: ['cube'] });
    await owner.request({ t: 'lock.release' }, 'lock.result');
    joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'property', ids: ['cube'], d: { f: { name: 'x' } } }] });
    expect(await editSequencesReceive(owner, joiner.user, 1)).toEqual([2]);
  });

  test('creates are not locked; a delete is refused while another member works on or inside it', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    joiner.send({
      t: 'edit',
      seq: 1,
      ops: [
        { k: 'create', ids: ['new1'], d: { type: 'brush' } },
        { k: 'geometry', ids: ['new1'], d: { v: [] } },
      ],
    });
    expect((await owner.next('edits')).list[0].ops.length).toBe(2);
    expect(await owner.request({ t: 'lock.acquire', ids: ['child'], shared: ['new1'] }, 'lock.result')).toMatchObject({
      ok: true,
    });
    joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'delete', ids: ['new1'] }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'lock_conflict', ids: ['new1'] });
    await owner.request({ t: 'lock.release' }, 'lock.result');
    joiner.send({ t: 'edit', seq: 3, ops: [{ k: 'delete', ids: ['new1'] }] });
    expect(await editSequencesReceive(owner, joiner.user, 1)).toEqual([3]);
  });

  test('members cannot lock or edit before their snapshot finished', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const joiner = await connect();
    await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    expect(await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result')).toMatchObject({
      t: 'error',
      code: 'not_synced',
    });
  });
});

describe('streams', () => {
  test('large snapshots stream in chunks with credit back to the owner', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const snapshot = crypto.getRandomValues(new Uint8Array(65536)).slice();
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let offset = 0; offset < big.length; offset += snapshot.length) big.set(snapshot, offset);
    const { received } = await joinSynced(owner, roomId, big);
    expect(received.byteLength).toBe(big.byteLength);
    expect(Buffer.compare(Buffer.from(received), Buffer.from(big))).toBe(0);
    let credited = 0;
    while (credited < big.byteLength) credited = (await owner.next('stream.credit')).delivered;
    expect(credited).toBe(big.byteLength);
  });

  test('owner edits made before the snapshot are not sent twice to the joiner', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    await owner.request({ t: 'lock.acquire', ids: ['o1'] }, 'lock.result');
    const joiner = await connect();
    await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    owner.send({ t: 'edit', seq: 1, ops: [{ k: 'transform', ids: ['o1'] }] });
    await snapshotSend(owner, new Uint8Array([1, 2, 3]));
    owner.send({ t: 'edit', seq: 2, ops: [{ k: 'transform', ids: ['o1'] }] });
    await streamReceive(joiner);
    const edits = await joiner.next('edits');
    expect(edits.list.map((entry: { seq: number }) => entry.seq)).toEqual([2]);
  });

  test('asset requests are relayed to the owner and answered with a stream or a miss', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    joiner.send({ t: 'asset.request', name: 'textures/wall.png' });
    const request = await owner.next('asset.request');
    expect(request).toMatchObject({ from: joiner.user, name: 'textures/wall.png' });
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    assetStreamSend(owner, joiner.user, png);
    expect(Array.from(await streamReceive(joiner))).toEqual(Array.from(png));
    joiner.send({ t: 'asset.request', name: 'missing.png' });
    await owner.next('asset.request');
    owner.send({ t: 'asset.missing', to: joiner.user, name: 'missing.png' });
    expect((await joiner.next('asset.missing')).name).toBe('missing.png');
  });

  test('streams cannot exceed their declared size, and members cannot send binary frames', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    owner.send({ t: 'stream.begin', to: joiner.user, stream: 5, kind: 'asset', size: 4, name: 'a.bin' });
    owner.sendRaw(binaryFrameEncode(5, joiner.user, new Uint8Array(8)));
    expect((await owner.next('stream.abort')).reason).toBe('exceeds declared size');
    expect((await joiner.next('stream.abort')).stream).toBe(5);
    joiner.sendRaw(binaryFrameEncode(1, owner.user, new Uint8Array(4)));
    expect(await joiner.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('unrequested snapshots are refused', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    owner.send({ t: 'stream.begin', to: joiner.user, stream: 2, kind: 'snapshot', size: 1 });
    expect(await owner.next('error')).toMatchObject({ code: 'stream_invalid' });
  });
});
