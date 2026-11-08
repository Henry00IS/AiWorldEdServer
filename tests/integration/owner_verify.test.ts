/**
 * End-to-end tests of owner verification: a member's claimed ancestors only
 * become shared locks after the room owner confirms them, and lying, slow or
 * departing owners and flooding members are handled.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { customFrameEncode, customFrameParse } from '../../src/shared/custom_frame.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient } from '../support/test_client.ts';
import { roomCreate, testRoomJoinSynced, verifyAnswer } from '../support/test_room.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
let port = 0;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test.
 *
 * @returns Connected client.
 */
async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

/**
 * Creates a room with one synced joiner.
 *
 * @returns Owner and joiner.
 */
async function roomPair(): Promise<{ owner: TestClient; joiner: TestClient }> {
  const owner = await connect();
  const roomId = await roomCreate(owner);
  const { joiner } = await testRoomJoinSynced(await connect(), owner, roomId);
  return { owner, joiner };
}

/**
 * Sends a lock request with a request id without waiting.
 *
 * @param client Sender.
 * @param requestId Request id.
 * @param fields Request fields.
 */
function lockSend(client: TestClient, requestId: number, fields: Record<string, unknown>): void {
  client.send({ t: 'lock.acquire', r: requestId, ...fields });
}

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({
      verifyTimeoutMs: 300,
      verifyPerMemberPerSecond: 0.001,
      verifyPerMemberBurst: 4,
      verifyQueueMessagesMaximum: 3,
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

describe('owner verification of lock claims', () => {
  test('the owner is trusted and is never asked about its own claims', async () => {
    const { owner } = await roomPair();
    const granted = await owner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group'] }, 'lock.result');
    expect(granted).toMatchObject({ ok: true });
    expect(owner.has('verify')).toBe(false);
  });

  test('a confirmed claim is granted and held ancestors are not asked about again', async () => {
    const { owner, joiner } = await roomPair();
    const pending = joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group', 'outer'] }, 'lock.result');
    expect(await verifyAnswer(owner)).toMatchObject({ t: 'verify', ids: ['cube'], anc: ['group', 'outer'] });
    expect(await pending).toMatchObject({ ok: true, add: ['cube'] });
    const again = await joiner.request({ t: 'lock.acquire', ids: ['sphere'], shared: ['group'] }, 'lock.result');
    expect(again).toMatchObject({ ok: true });
    expect(owner.has('verify')).toBe(false);
  });

  test('refuted and deleted claims are denied and nothing is locked', async () => {
    const { owner, joiner } = await roomPair();
    const lie = joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['other'] }, 'lock.result');
    await verifyAnswer(owner, 'invalid');
    expect(await lie).toMatchObject({ ok: false, code: 'lock_unverified', why: 'invalid' });
    const gone = joiner.request({ t: 'lock.acquire', ids: ['ghost'], shared: ['group'] }, 'lock.result');
    await verifyAnswer(owner, 'deleted');
    expect(await gone).toMatchObject({ ok: false, code: 'lock_unverified', why: 'deleted' });
    expect(await owner.request({ t: 'lock.acquire', ids: ['other', 'group'] }, 'lock.result')).toMatchObject({
      ok: true,
    });
    expect(owner.has('locks')).toBe(false);
  });

  test('a conflicting claim is refused before the owner is asked', async () => {
    const { owner, joiner } = await roomPair();
    await owner.request({ t: 'lock.acquire', ids: ['group'] }, 'lock.result');
    const refused = await joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group'] }, 'lock.result');
    expect(refused).toMatchObject({ ok: false, code: 'lock_conflict' });
    expect(owner.has('verify')).toBe(false);
  });

  test('a silent owner times out and its late answer is ignored', async () => {
    const { owner, joiner } = await roomPair();
    const pending = joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group'] }, 'lock.result');
    const query = await owner.next('verify');
    expect(await pending).toMatchObject({ ok: false, code: 'lock_unverified', why: 'owner_timeout' });
    owner.send({ t: 'verify.result', q: query.q, v: 'ok' });
    expect(await owner.request({ t: 'lock.acquire', ids: ['group'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('an owner that leaves denies the open query', async () => {
    const { owner, joiner } = await roomPair();
    const pending = joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group'] }, 'lock.result');
    await owner.next('verify');
    owner.close();
    expect(await pending).toMatchObject({ ok: false, code: 'lock_unverified', why: 'owner_left' });
  });

  test('requests behind an open query keep their order', async () => {
    const { owner, joiner } = await roomPair();
    lockSend(joiner, 1, { ids: ['cube'], shared: ['group'] });
    joiner.send({ t: 'lock.release', r: 2, ids: ['cube'] });
    lockSend(joiner, 3, { ids: ['sphere'] });
    await verifyAnswer(owner);
    const replies = [await joiner.next('lock.result'), await joiner.next('lock.result')];
    replies.push(await joiner.next('lock.result'));
    expect(replies.map((reply) => [reply.r, reply.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  test('a member that floods queries is rate limited', async () => {
    const { owner, joiner } = await roomPair();
    for (let index = 0; index < 4; index++) {
      const pending = joiner.request({ t: 'lock.acquire', ids: [`a${index}`], shared: [`g${index}`] }, 'lock.result');
      await verifyAnswer(owner);
      expect(await pending).toMatchObject({ ok: true });
    }
    const flooded = await joiner.request({ t: 'lock.acquire', ids: ['a9'], shared: ['g9'] }, 'lock.result');
    expect(flooded).toMatchObject({ ok: false, code: 'lock_unverified', why: 'rate_limited' });
    expect(owner.has('verify')).toBe(false);
  });

  test('too many requests behind an open query close the connection', async () => {
    const { owner, joiner } = await roomPair();
    lockSend(joiner, 1, { ids: ['cube'], shared: ['group'] });
    for (let index = 0; index < 4; index++) lockSend(joiner, 10 + index, { ids: [`x${index}`] });
    await owner.next('verify');
    expect(await joiner.closed()).toBe(CLOSE_CODES.rateLimited);
  });

  test('only the owner may answer', async () => {
    const { joiner } = await roomPair();
    joiner.send({ t: 'verify.result', q: 1, v: 'ok' });
    expect(await joiner.next('error')).toMatchObject({ code: 'not_owner' });
  });
});

describe('owner verification of edit parent chains', () => {
  test('a chain is sent as its head and the head ancestors', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'reparent', ids: ['cube'], d: {}, p: ['inner', 'middle', 'outer'] }] });
    expect(await verifyAnswer(owner)).toMatchObject({ ids: ['inner'], anc: ['middle', 'outer'] });
    expect((await owner.next('edits')).list[0].ops[0].p).toEqual(['inner', 'middle', 'outer']);
  });

  test('a refuted chain rejects the edit and relays nothing', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'reparent', ids: ['cube'], d: {}, p: ['group', 'fake'] }] });
    await verifyAnswer(owner, 'invalid');
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'lock_unverified', why: 'invalid' });
    await Bun.sleep(50);
    expect(owner.has('edits')).toBe(false);
    expect(await owner.request({ t: 'lock.acquire', ids: ['group', 'fake'] }, 'lock.result')).toMatchObject({
      ok: true,
    });
  });

  test('a chain that contradicts a create in the same batch is rejected without asking', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({
      t: 'edit',
      seq: 1,
      ops: [
        { k: 'create', ids: ['box'], d: {}, p: ['group'] },
        { k: 'create', ids: ['inner'], d: {}, p: ['box', 'elsewhere'] },
      ],
    });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'lock_unverified', why: 'invalid' });
    expect(owner.has('verify')).toBe(false);
  });

  test('a chain through a create in the same batch only asks about the real head', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({
      t: 'edit',
      seq: 1,
      ops: [
        { k: 'create', ids: ['box'], d: {}, p: ['group'] },
        { k: 'create', ids: ['inner'], d: {}, p: ['box', 'group'] },
      ],
    });
    expect(await verifyAnswer(owner)).toMatchObject({ ids: ['group'], anc: [] });
    expect((await owner.next('edits')).list[0].ops.length).toBe(2);
  });
});

/**
 * Custom traffic cannot overtake an earlier scene edit waiting on owner
 * verification.
 */
test('custom frames share the held edit FIFO until verification completes', async () => {
  const { owner, joiner } = await roomPair();
  await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
  joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'reparent', ids: ['cube'], d: {}, p: ['inner', 'outer'] }] });
  const query = await owner.next('verify');
  joiner.sendRaw(customFrameEncode(777, 0, new Uint8Array([0, 255])));
  await joiner.request({ t: 'ping' }, 'pong');
  expect(owner.inbox.some((item) => item.kind === 'binary')).toBe(false);
  expect(server.core.sessions.get(joiner.user)?.verify.heldCount()).toBe(1);
  owner.send({ t: 'verify.result', q: query.q, v: 'ok' });
  expect((await owner.next('edits')).list[0].ops[0].k).toBe('reparent');
  expect(customFrameParse(await owner.nextBinary())?.payload).toEqual(new Uint8Array([0, 255]));
  expect(await joiner.next('custom.sent')).toMatchObject({ r: 777 });
});
