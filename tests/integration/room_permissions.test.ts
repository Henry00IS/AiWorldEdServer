/** Hostile clients exercise every write boundary against a real ephemeral relay. */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { EDIT_KINDS } from '../../src/shared/protocol_definitions.ts';
import { customFrameEncode } from '../../src/shared/custom_frame.ts';
import { TestClient } from '../support/test_client.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
const clients: TestClient[] = [];

/** Opens a tracked connection. @returns Connected client. */
async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(server.port);
  clients.push(client);
  return client;
}

/** Creates a default viewer room. @returns Owner, viewer and live room. */
async function pair() {
  const owner = await connect();
  const id = await roomCreate(owner, { editMode: undefined });
  const viewer = await connect();
  await testRoomJoinSynced(viewer, owner, id);
  const room = server.core.registry.get(id);
  if (!room) throw new Error('missing fixture room');
  return { owner, viewer, room, id };
}

/**
 * Refuses every scene operation and live preview. @param viewer Read-only
 * sender.
 */
async function writesRefused(viewer: TestClient): Promise<void> {
  let seq = 0;
  for (const k of EDIT_KINDS) {
    viewer.send({ t: 'edit', seq: ++seq, ops: [{ k, ids: ['target'], d: {} }] });
    expect(await viewer.next('edit.rejected')).toMatchObject({ seq, reason: 'read_only' });
  }
  viewer.send({ t: 'edit', seq: ++seq, lease: 1, ops: [{ k: 'transform', ids: ['target'], d: { live: 1 } }] });
  expect(await viewer.next('edit.rejected')).toMatchObject({ seq, reason: 'read_only' });
}

beforeAll(() => {
  server = collabServerStart(testConfiguration());
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
afterAll(async () => {
  await server.stop();
});

test('default public viewers cannot send any edit kind, live previews, leases or opaque writes', async () => {
  const { owner, viewer, room } = await pair();
  expect(room.memberList().find((entry) => entry.user === viewer.user)?.canEdit).toBe(false);
  await writesRefused(viewer);
  expect(await viewer.request({ t: 'lock.acquire', ids: ['target'] }, 'lock.result')).toMatchObject({
    ok: false,
    code: 'read_only',
  });
  viewer.send({ t: 'lock.renew' });
  expect(await viewer.next('error')).toMatchObject({ code: 'read_only' });
  expect(await viewer.request({ t: 'custom.lock.acquire', keys: ['extension'] }, '*')).toMatchObject({
    code: 'read_only',
  });
  viewer.sendRaw(customFrameEncode(72, 0, new Uint8Array([1])));
  expect(await viewer.next('error')).toMatchObject({ r: 72, code: 'read_only' });
  await viewer.request({ t: 'ping' }, 'pong');
  expect(owner.has('edits')).toBe(false);
  expect(room.locks.countFor(viewer.user)).toBe(0);
  viewer.send({ t: 'select', ids: ['target'] });
  expect(await owner.next('selected')).toMatchObject({ by: viewer.user });
  expect(await viewer.request({ t: 'chat', text: 'Still here' }, 'chat.sent')).toMatchObject({ text: 'Still here' });
});

test('only the owner may grant or kick, including cross-room and owner targets', async () => {
  const { owner, viewer } = await pair();
  expect(await viewer.request({ t: 'member.permission.set', user: viewer.user, canEdit: true }, '*')).toMatchObject({
    code: 'not_owner',
  });
  expect(await viewer.request({ t: 'member.kick', user: owner.user }, '*')).toMatchObject({ code: 'not_owner' });
  const outsider = await connect();
  for (const user of [outsider.user, owner.user]) {
    expect(await owner.request({ t: 'member.permission.set', user, canEdit: true }, '*')).toMatchObject({
      code: 'member_not_found',
    });
    expect(await owner.request({ t: 'member.kick', user }, '*')).toMatchObject({ code: 'member_not_found' });
  }
});

test('grant enables writes and revoke releases leases, custom locks and previews immediately', async () => {
  const { owner, viewer, room } = await pair();
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: true }, 'member.permission.result');
  expect(await viewer.next('member.permission')).toMatchObject({ canEdit: true });
  expect(await viewer.request({ t: 'lock.acquire', ids: ['target'] }, 'lock.result')).toMatchObject({ ok: true });
  await viewer.request({ t: 'custom.lock.acquire', keys: ['extension'] }, 'custom.lock.acquired');
  viewer.send({ t: 'edit', seq: 1, lease: viewer.lease, ops: [{ k: 'transform', ids: ['target'], d: { live: 1 } }] });
  expect((await owner.next('edits')).list[0]).toMatchObject({ from: viewer.user });
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: false }, 'member.permission.result');
  expect(await viewer.next('locks', (message) => message.expired === true)).toMatchObject({ remove: ['target'] });
  expect(room.locks.countFor(viewer.user)).toBe(0);
  expect(room.customLocks.countFor(viewer.user)).toBe(0);
  viewer.send({ t: 'edit', seq: 2, lease: viewer.lease, ops: [{ k: 'delete', ids: ['target'] }] });
  expect(await viewer.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'read_only' });
});

test('revocation refuses a parked verification and every queued write with correlated replies', async () => {
  const { owner, viewer, room } = await pair();
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: true }, 'member.permission.result');
  viewer.send({ t: 'lock.acquire', r: 401, ids: ['target'], shared: ['parent'] });
  const query = await owner.next('verify');
  viewer.send({ t: 'edit', seq: 402, ops: [{ k: 'delete', ids: ['target'] }] });
  await viewer.request({ t: 'ping' }, 'pong');
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: false }, 'member.permission.result');
  expect(await viewer.next('lock.result', (message) => message.r === 401)).toMatchObject({
    ok: false,
    code: 'read_only',
  });
  expect(await viewer.next('edit.rejected')).toMatchObject({ seq: 402, reason: 'read_only' });
  owner.send({ t: 'verify.result', q: query.q, v: 'ok' });
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: true }, 'member.permission.result');
  expect(room.locks.countFor(viewer.user)).toBe(0);
});

test('kick ends only room membership, clears grants and permits an explicit viewer rejoin', async () => {
  const { owner, viewer, room, id } = await pair();
  await owner.request({ t: 'member.permission.set', user: viewer.user, canEdit: true }, 'member.permission.result');
  await owner.request({ t: 'member.kick', user: viewer.user }, 'member.kicked');
  expect(await viewer.next('room.left')).toMatchObject({ reason: 'kicked' });
  expect(viewer.closeCode).toBe(null);
  expect(room.members.has(viewer.user)).toBe(false);
  await viewer.request({ t: 'ping' }, 'pong');
  await testRoomJoinSynced(viewer, owner, id);
  expect(room.memberList().find((entry) => entry.user === viewer.user)?.canEdit).toBe(false);
});

test('open public rooms and password rooms admit editors unchanged', async () => {
  for (const extra of [{ editMode: 'anyone' }, { private: true, password: 'mR9!wZ4@pK8#', editMode: 'viewers' }]) {
    const owner = await connect();
    const id = await roomCreate(owner, extra);
    const viewer = await connect();
    await testRoomJoinSynced(viewer, owner, id, undefined, 'password' in extra ? { password: extra.password } : {});
    const room = server.core.registry.get(id);
    expect(room?.memberList().find((entry) => entry.user === viewer.user)?.canEdit).toBe(true);
    viewer.send({ t: 'edit', seq: 1, ops: [{ k: 'property', ids: ['target'], d: {} }] });
    expect((await owner.next('edits')).list[0]).toMatchObject({ from: viewer.user });
  }
});
