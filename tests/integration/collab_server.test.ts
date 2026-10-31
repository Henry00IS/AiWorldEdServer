/**
 * End-to-end tests against a real local relay over real WebSockets. Rooms
 * use the internal test flag, which is only accepted from direct (non-proxied)
 * connections. The forwarded secret is a dummy value from the test config.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { binaryFrameEncode, binaryFrameParse, binaryFramePayload } from '../../src/shared/binary_frame.ts';
import { CLOSE_CODES, PROTOCOL_ID } from '../../src/shared/protocol_definitions.ts';
import { passwordGenerate } from '../../src/shared/password_generator.ts';
import { TestClient, testConnectionRefused } from '../support/test_client.ts';
import { TEST_DUMMY_FORWARDED_SECRET, TEST_ORIGIN, testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

/** Connects a client that is closed after the suite. */
async function connect(options: Parameters<typeof TestClient.connect>[1] = {}): Promise<TestClient> {
  const client = await TestClient.connect(port, options);
  clients.push(client);
  return client;
}

/** Headers that look like a request forwarded by the proxy (dummy secret). */
function proxiedHeaders(clientIp: string): Record<string, string> {
  return { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': clientIp, 'X-Forwarded-For': clientIp };
}

/** Creates an internal test room and returns its id. */
async function roomCreate(owner: TestClient, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await owner.request({ t: 'room.create', name: `test room ${Math.random()}`, private: false, internalTest: true, ...extra }, 'room.created');
  expect(reply.t).toBe('room.created');
  return reply.room.id;
}

/** Owner answers the pending snapshot request with the given bytes. */
async function snapshotSend(owner: TestClient, snapshot: Uint8Array, streamId = 1): Promise<number> {
  const request = await owner.next('snapshot.request');
  owner.send({ t: 'stream.begin', to: request.for, stream: streamId, kind: 'snapshot', size: snapshot.byteLength });
  for (let offset = 0; offset < snapshot.byteLength; offset += 64 * 1024) {
    owner.sendRaw(binaryFrameEncode(streamId, request.for, snapshot.subarray(offset, offset + 64 * 1024)));
  }
  owner.send({ t: 'stream.end', to: request.for, stream: streamId });
  return request.for;
}

/** Joins and receives the full snapshot; returns the joiner and the snapshot bytes. */
async function joinSynced(owner: TestClient, roomId: string, snapshot = new TextEncoder().encode('{"world":1}')): Promise<{ joiner: TestClient; received: Uint8Array }> {
  const joiner = await connect();
  const joined = await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
  expect(joined.t).toBe('room.joined');
  await snapshotSend(owner, snapshot);
  return { joiner, received: await streamReceive(joiner) };
}

/** Collects one stream on the receiving side. */
async function streamReceive(receiver: TestClient): Promise<Uint8Array> {
  const begin = await receiver.next('stream.begin');
  const parts: Uint8Array[] = [];
  let received = 0;
  while (received < begin.size) {
    const frame = await receiver.nextBinary();
    const chunk = binaryFrameParse(frame, 1 << 20);
    if (!chunk) throw new Error('bad chunk');
    expect(chunk.stream).toBe(begin.stream);
    expect(chunk.peer).toBe(begin.from);
    parts.push(binaryFramePayload(frame).slice());
    received += chunk.payloadBytes;
  }
  await receiver.next('stream.end', (message) => message.stream === begin.stream);
  const result = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) result.set(part, (offset += part.byteLength) - part.byteLength);
  return result;
}

beforeAll(() => {
  server = collabServerStart(testConfiguration({ handshakeTimeoutMs: 300, connectionsPerIp: 200, joinFailuresPerIpPerMinute: 1000, joinFailuresPerRoomPerMinute: 3 }));
  port = server.port;
});

afterEach(async () => {
  // Every direct test client shares 127.0.0.1, so free its rooms and connection slots between tests.
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

describe('handshake and gatekeeping', () => {
  test('hello yields welcome with limits; direct connections report via=direct', async () => {
    const client = await connect({ name: '  Tester  ' });
    expect(client.welcome).toMatchObject({ protocol: PROTOCOL_ID, version: 1, via: 'direct', name: 'Tester' });
    expect(client.welcome.limits.roomsPerIp).toBe(8);
    client.send({ t: 'ping', r: 5 });
    expect((await client.next('pong')).r).toBe(5);
  });

  test('upgrade is refused without an allowed Origin and with a wrong forwarded secret', async () => {
    expect(await testConnectionRefused(port, {})).toBe(true);
    expect(await testConnectionRefused(port, { Origin: 'https://evil.example' })).toBe(true);
    expect(await testConnectionRefused(port, { Origin: TEST_ORIGIN, 'X-Forwarded-Secret': 'wrong-secret' })).toBe(true);
    expect(await testConnectionRefused(port, { Origin: TEST_ORIGIN, 'X-Forwarded-Secret': '' })).toBe(true);
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
    ['wrong version', JSON.stringify({ t: 'hello', protocol: PROTOCOL_ID, version: 2, client: 'x' })],
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
    const tooLong = await owner.request({ t: 'room.create', name: 'x'.repeat(129), private: false, internalTest: true }, 'room.created');
    expect(tooLong).toMatchObject({ t: 'error', code: 'invalid_name' });
    const control = await owner.request({ t: 'room.create', name: 'bad\u0007', private: false, internalTest: true }, 'room.created');
    expect(control).toMatchObject({ t: 'error', code: 'invalid_name' });
  });

  test('private rooms require a strong password and verify it', async () => {
    const owner = await connect();
    for (const weak of ['00000000', 'Password1!', 'Abcd1234!x']) {
      const reply = await owner.request({ t: 'room.create', name: 'secret', private: true, password: weak, internalTest: true }, 'room.created');
      expect(reply).toMatchObject({ t: 'error', code: 'weak_password' });
    }
    const password = passwordGenerate();
    const roomId = await roomCreate(owner, { private: true, password });
    const list = await owner.request({ t: 'room.list' }, 'room.list');
    const entry = list.rooms.find((room: { id: string }) => room.id === roomId);
    expect(entry.private).toBe(true);
    expect(JSON.stringify(entry)).not.toContain(password);

    const joiner = await connect();
    expect(await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined')).toMatchObject({ code: 'password_required' });
    expect(await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true, password: 'Wrong-Pass9!' }, 'room.joined')).toMatchObject({ code: 'wrong_password' });
    const joined = await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true, password }, 'room.joined');
    expect(joined.t).toBe('room.joined');
  });

  test('wrong passwords are rate limited per room', async () => {
    const owner = await connect();
    const password = passwordGenerate();
    const roomId = await roomCreate(owner, { private: true, password });
    const joiner = await connect();
    for (let attempt = 0; attempt < 3; attempt++) {
      await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true, password: 'Wrong-Pass9!' }, 'room.joined');
    }
    const blocked = await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true, password }, 'room.joined');
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
    const rejoin = await (await connect()).request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    expect(rejoin).toMatchObject({ t: 'error', code: 'room_not_found' });
  });

  test('at most 8 owned rooms per IP address', async () => {
    const owners: TestClient[] = [];
    for (let index = 0; index < 8; index++) {
      const owner = await connect({ headers: proxiedHeaders('198.51.100.20') });
      expect((await owner.request({ t: 'room.create', name: `limit ${index}`, private: false }, 'room.created')).t).toBe('room.created');
      owners.push(owner);
    }
    const ninth = await connect({ headers: proxiedHeaders('198.51.100.20') });
    expect(await ninth.request({ t: 'room.create', name: 'limit 9', private: false }, 'room.created')).toMatchObject({ code: 'room_limit_ip' });
    const otherIp = await connect({ headers: proxiedHeaders('198.51.100.21') });
    expect((await otherIp.request({ t: 'room.create', name: 'other ip', private: false }, 'room.created')).t).toBe('room.created');
    (owners[0] as TestClient).close();
    await Bun.sleep(50);
    expect((await ninth.request({ t: 'room.create', name: 'limit 9', private: false }, 'room.created')).t).toBe('room.created');
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
    const create = await proxied.request({ t: 'room.create', name: 'sneaky', private: false, internalTest: true }, 'room.created');
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
    expect(await owner.request({ t: 'lock.acquire', ids: ['a', 'b'] }, 'lock.result')).toMatchObject({ ok: true, add: ['a', 'b'] });
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

  test('edits require locks and are relayed in order to everybody else', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner: first } = await joinSynced(owner, roomId);
    const { joiner: second } = await joinSynced(owner, roomId);
    first.send({ t: 'edit', seq: 1, ops: [{ k: 'transform', ids: ['cube'], d: { p: [1, 0, 0] } }] });
    expect(await first.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'not_locked', ids: ['cube'] });
    await first.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    for (let seq = 2; seq <= 6; seq++) first.send({ t: 'edit', seq, ops: [{ k: 'transform', ids: ['cube'], d: { p: [seq, 0, 0] } }] });
    for (const recipient of [owner, second]) {
      const seen: number[] = [];
      while (seen.length < 5) {
        const frame = await recipient.next('edits');
        for (const entry of frame.list) {
          expect(entry.from).toBe(first.user);
          seen.push(entry.seq);
        }
      }
      expect(seen).toEqual([2, 3, 4, 5, 6]);
    }
    expect(first.has('edits')).toBe(false);
  });

  test('create grants locks to the creator and delete releases them', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const { joiner } = await joinSynced(owner, roomId);
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'create', ids: ['new1'], d: { type: 'brush' } }, { k: 'geometry', ids: ['new1'], d: { v: [] } }] });
    expect((await owner.next('edits')).list[0].ops.length).toBe(2);
    expect(await owner.request({ t: 'lock.acquire', ids: ['new1'] }, 'lock.result')).toMatchObject({ ok: false, code: 'lock_conflict' });
    joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'delete', ids: ['new1'] }] });
    await owner.next('edits');
    await owner.next('locks', (message) => message.by === joiner.user && message.remove?.includes('new1'));
    expect(await owner.request({ t: 'lock.acquire', ids: ['new1'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('members cannot lock or edit before their snapshot finished', async () => {
    const owner = await connect();
    const roomId = await roomCreate(owner);
    const joiner = await connect();
    await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    expect(await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result')).toMatchObject({ t: 'error', code: 'not_synced' });
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
    owner.send({ t: 'stream.begin', to: joiner.user, stream: 9, kind: 'asset', size: png.length, name: 'textures/wall.png', mime: 'image/png' });
    owner.sendRaw(binaryFrameEncode(9, joiner.user, png));
    owner.send({ t: 'stream.end', to: joiner.user, stream: 9 });
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
