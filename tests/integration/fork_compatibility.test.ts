/**
 * Real relay tests proving fail-closed admission, privacy and opaque custom
 * routing.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate, testRoomJoinSynced, snapshotSend, streamReceive } from '../support/test_room.ts';
import { customFrameEncode, customFrameParse } from '../../src/shared/custom_frame.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';

let server: CollabServer;
const clients: TestClient[] = [];
beforeAll(() => {
  server = collabServerStart(testConfiguration({ compatibilityTimeoutMs: 100, roomEntryBurstPerIp: 1000 }));
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
afterAll(async () => {
  await server.stop();
});

/** Connects a tracked fixture. @returns Connected tracked test client. */
async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(server.port);
  clients.push(client);
  return client;
}

/**
 * Creates matching synced fixtures. @returns Owner, matching member and their
 * synced room.
 */
async function synced() {
  const owner = await connect();
  const member = await connect();
  const room = await roomCreate(owner);
  await testRoomJoinSynced(member, owner, room);
  return { owner, member, room };
}

/**
 * Sends custom bytes and waits for correlated relay confirmation or error.
 *
 * @param sender Sender.
 * @param peer Target id or zero for owner.
 * @param bytes Payload.
 * @param guard Optional scene lock envelope.
 * @returns Reply.
 */
async function custom(sender: TestClient, peer: number, bytes: Uint8Array, guard = {}) {
  const r = Math.floor(Math.random() * 0x7fffffff);
  sender.sendRaw(customFrameEncode(r, peer, bytes, guard));
  return sender.next('*', (reply) => reply.r === r);
}

test('matching joins pass but version/schema mismatches and missing identity are denied', async () => {
  const { owner, room } = await synced();
  for (const identity of [{ version: '1', schema: 2, caps: [] }, { version: '2', schema: 1, caps: [] }, undefined]) {
    const joiner = await connect();
    const reply = await joiner.request(
      { t: 'room.join', room, discardLocalWork: true, compatibility: identity },
      'room.joined',
    );
    expect(reply.code).toBe('client_incompatible');
    expect(owner.has('snapshot.request')).toBe(false);
  }
});

test('owner denial URL and reason reach only the denied joiner; joiner sends no URL', async () => {
  const owner = await connect();
  owner.compatibilityAutomatic = false;
  const room = await roomCreate(owner);
  const member = await connect();
  const identity = { version: 'fork-build', schema: 7, caps: ['custom:terrain', 'future'] };
  member.send({ t: 'room.join', room, discardLocalWork: true, compatibility: identity });
  const query = await owner.next('compatibility.check');
  expect(query.compatibility).toEqual(identity);
  expect(Object.keys(query.compatibility).sort()).toEqual(['caps', 'schema', 'version']);
  const homeUrl = 'https://owner.invalid/' + 'x'.repeat(234);
  expect(homeUrl).toHaveLength(256);
  owner.send({ t: 'compatibility.result', q: query.q, allow: false, reason: 'missing_caps', homeUrl });
  const denial = await member.next('error');
  expect(denial).toMatchObject({ code: 'client_incompatible', reason: 'missing_caps', homeUrl });
});

test('oversize owner URLs violate the schema and malicious schemes are omitted from denial', async () => {
  const owner = await connect();
  owner.compatibilityAutomatic = false;
  const room = await roomCreate(owner);
  const member = await connect();
  member.send({ t: 'room.join', room, discardLocalWork: true });
  const query = await owner.next('compatibility.check');
  owner.send({ t: 'compatibility.result', q: query.q, allow: false, homeUrl: 'javascript:alert(1)' });
  expect((await member.next('error')).homeUrl).toBeUndefined();
  member.send({ t: 'room.join', room, discardLocalWork: true });
  const next = await owner.next('compatibility.check');
  owner.send({
    t: 'compatibility.result',
    q: next.q,
    allow: false,
    homeUrl: 'https://owner.invalid/' + 'x'.repeat(235),
  });
  expect(await owner.closed()).toBe(CLOSE_CODES.protocolViolation);
});

test('pending joiner gets no room data; lying non-owner verdict cannot approve admission', async () => {
  const owner = await connect();
  owner.compatibilityAutomatic = false;
  const room = await roomCreate(owner);
  const member = await connect();
  member.send({
    t: 'room.join',
    room,
    discardLocalWork: true,
    compatibility: { version: '1', schema: 1, caps: [] },
  });
  const query = await owner.next('compatibility.check');
  member.send({ t: 'compatibility.result', q: query.q, allow: true });
  await member.request({ t: 'ping' }, 'pong');
  expect(member.has('room.joined')).toBe(false);
  expect(member.has('member.joined')).toBe(false);
  expect(owner.has('snapshot.request')).toBe(false);
  expect((await custom(member, 0, new Uint8Array([1]))).code).toBe('not_in_room');
  owner.send({ t: 'compatibility.result', q: query.q, allow: false });
  expect((await member.next('error')).code).toBe('client_incompatible');
});

test('owner silence denies explicitly with a timeout reason', async () => {
  const owner = await connect();
  owner.compatibilityAutomatic = false;
  const room = await roomCreate(owner);
  const member = await connect();
  const result = await member.request({ t: 'room.join', room, discardLocalWork: true }, 'room.joined');
  expect(result.code).toBe('client_incompatible');
  expect(Object.keys(result).sort()).toEqual(['code', 'r', 'reason', 't']);
  expect(result.reason).toBe('owner_timeout');
  expect(owner.has('snapshot.request')).toBe(false);
});

test('owner departure denies pending join and stale approval cannot admit it', async () => {
  const owner = await connect();
  owner.compatibilityAutomatic = false;
  const room = await roomCreate(owner);
  const member = await connect();
  member.send({ t: 'room.join', room, discardLocalWork: true });
  const query = await owner.next('compatibility.check');
  await owner.request({ t: 'room.leave' }, 'room.left');
  owner.send({ t: 'compatibility.result', q: query.q, allow: true });
  expect((await member.next('error')).code).toBe('client_incompatible');
});

test('opaque binary integrity and owner/member-only targeting', async () => {
  const { owner, member, room } = await synced();
  const other = await connect();
  await testRoomJoinSynced(other, owner, room);
  const bytes = new Uint8Array([0, 255, 128, 1, 0, 37, 13, 10]);
  expect((await custom(member, 0, bytes)).t).toBe('custom.sent');
  const received = customFrameParse(await owner.nextBinary());
  expect(received?.payload).toEqual(bytes);
  expect(received?.peer).toBe(member.user);
  expect((await custom(owner, member.user, bytes)).t).toBe('custom.sent');
  expect(customFrameParse(await member.nextBinary())?.payload).toEqual(bytes);
  expect((await custom(owner, 0xffffffff, bytes)).code).toBe('custom_target_invalid');
  expect((await custom(member, other.user, bytes)).code).toBe('custom_target_invalid');
  expect(other.inbox.some((item) => item.kind === 'binary')).toBe(false);
});

test('exact 256 KiB passes, excess reports an error, oversized single payload rejected', async () => {
  const { owner, member } = await synced();
  const bytes = new Uint8Array(256 * 1024);
  expect((await custom(member, 0, bytes)).t).toBe('custom.sent');
  expect(customFrameParse(await owner.nextBinary())?.payload).toEqual(bytes);
  expect((await custom(member, 0, new Uint8Array(1))).code).toBe('custom_rate_limited');
  expect((await custom(owner, member.user, new Uint8Array(bytes.length + 1))).code).toBe('custom_too_large');
});

test('only synced members send and receive custom data or acquire custom locks', async () => {
  const owner = await connect();
  const member = await connect();
  const room = await roomCreate(owner);
  await member.request({ t: 'room.join', room, discardLocalWork: true }, 'room.joined');
  expect((await custom(member, 0, new Uint8Array([1]))).code).toBe('not_synced');
  expect((await custom(owner, member.user, new Uint8Array([1]))).code).toBe('custom_target_invalid');
  expect((await member.request({ t: 'custom.lock.acquire', keys: ['terrain'] }, 'custom.lock.acquired')).code).toBe(
    'not_synced',
  );
  await snapshotSend(owner, new Uint8Array([1]));
  await streamReceive(member);
  expect((await custom(member, 0, new Uint8Array([2]))).t).toBe('custom.sent');
});

test('custom locks are isolated from scene locks, conflict and release on disconnect', async () => {
  const { owner, member } = await synced();
  expect((await member.request({ t: 'custom.lock.acquire', keys: ['arbitrary / 🌎'] }, 'custom.lock.acquired')).t).toBe(
    'custom.lock.acquired',
  );
  expect(
    (await owner.request({ t: 'custom.lock.acquire', keys: ['arbitrary / 🌎'] }, 'custom.lock.acquired')).code,
  ).toBe('lock_conflict');
  member.close();
  await owner.next('member.left');
  expect((await owner.request({ t: 'custom.lock.acquire', keys: ['arbitrary / 🌎'] }, 'custom.lock.acquired')).t).toBe(
    'custom.lock.acquired',
  );
  expect((await owner.request({ t: 'custom.lock.release' }, 'custom.lock.released')).keys).toEqual(['arbitrary / 🌎']);
});

test('custom previews reuse lease stale, outside lease and other-holder conflict rules', async () => {
  const { owner, member } = await synced();
  await member.request({ t: 'lock.acquire', ids: ['terrain'], lease: 1 }, 'lock.result');
  expect((await custom(member, 0, new Uint8Array([1]), { lease: 2, ids: ['terrain'] })).code).toBe('lease_stale');
  expect((await custom(member, 0, new Uint8Array([1]), { lease: 1, ids: ['outside'] })).code).toBe('outside_lease');
  expect((await custom(owner, member.user, new Uint8Array([1]), { ids: ['terrain'] })).code).toBe('lock_conflict');
  expect((await custom(member, 0, new Uint8Array([1]), { lease: 1, ids: ['terrain'] })).t).toBe('custom.sent');
  expect(customFrameParse(await owner.nextBinary())?.payload).toEqual(new Uint8Array([1]));
});

/**
 * Hundreds of small updates are independent of the control-message token
 * bucket.
 */
test('600 small custom frames in one burst pass with byte-perfect ordered delivery', async () => {
  const { owner, member } = await synced();
  for (let r = 1; r <= 600; r++) member.sendRaw(customFrameEncode(r, 0, new Uint8Array([r & 255])));
  for (let r = 1; r <= 600; r++) {
    const parsed = customFrameParse(await owner.nextBinary());
    expect(parsed?.r).toBe(r);
    expect(parsed?.payload).toEqual(new Uint8Array([r & 255]));
  }
  expect(member.closeCode).toBeNull();
});

/**
 * Only the owner may request broadcast routing; every synced member gets
 * identical bytes.
 */
test('owner broadcast reaches all members; member broadcast is rejected', async () => {
  const { owner, member, room } = await synced();
  const other = await connect();
  await testRoomJoinSynced(other, owner, room);
  const bytes = new Uint8Array([255, 0, 128]);
  expect((await custom(owner, 0, bytes, { broadcast: true })).t).toBe('custom.sent');
  for (const receiver of [member, other]) expect(customFrameParse(await receiver.nextBinary())?.payload).toEqual(bytes);
  expect((await custom(member, 0, bytes, { broadcast: true })).code).toBe('custom_target_invalid');
});
