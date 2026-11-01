/**
 * End-to-end tests of barrier-free locking against a real local relay: one edit
 * lease per member, lease expiry, one-shot edits, selection presence and the
 * abuse rules that keep one member from flooding the room with "I am editing
 * everything".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient } from '../support/test_client.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test.
 *
 * @param target Relay to connect to.
 * @returns Connected client.
 */
async function connect(target: CollabServer = server): Promise<TestClient> {
  const client = await TestClient.connect(target.port);
  clients.push(client);
  return client;
}

/**
 * Creates a room with one synced joiner.
 *
 * @param target Relay to use.
 * @returns Owner, joiner and room id.
 */
async function roomPair(
  target: CollabServer = server,
): Promise<{ owner: TestClient; joiner: TestClient; roomId: string }> {
  const owner = await connect(target);
  const roomId = await roomCreate(owner);
  const { joiner } = await testRoomJoinSynced(await connect(target), owner, roomId);
  return { owner, joiner, roomId };
}

/**
 * Builds object ids.
 *
 * @param prefix Id prefix.
 * @param count Number of ids.
 * @returns Ids.
 */
function idsMake(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

/**
 * Reads the relay's misuse score of a connected member.
 *
 * @param client Member.
 * @returns Score, or -1 when the member is not in a room.
 */
function scoreOf(client: TestClient): number {
  const sessions = [...server.core.registry.all()].flatMap((room) => [...room.members.values()]);
  return sessions.find((session) => session.user === client.user)?.limits.abuse.value() ?? -1;
}

/**
 * Plays one honest drag: a new lease, ten live frames, a renewal, the release
 * and a one-shot rename afterwards.
 *
 * @param client Dragging member.
 * @param seqBase First edit sequence number minus one.
 */
async function honestDrag(client: TestClient, seqBase: number): Promise<void> {
  client.leaseNext();
  const granted = await client.request({ t: 'lock.acquire', ids: ['a'], replace: true }, 'lock.result');
  expect(granted).toMatchObject({ ok: true });
  const frame = { k: 'transform', ids: ['a'], d: {} };
  for (let index = 1; index <= 10; index++)
    client.send({ t: 'edit', seq: seqBase + index, lease: client.lease, ops: [frame] });
  client.send({ t: 'lock.renew' });
  await client.request({ t: 'lock.release' }, 'lock.result');
  client.send({ t: 'edit', seq: seqBase + 15, ops: [{ k: 'property', ids: ['a'], d: { f: { name: 'n' } } }] });
}

beforeAll(() => {
  server = collabServerStart(testConfiguration({ lockLeaseMs: 400, lockLeaseSweepMs: 50 }));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

describe('one operation per member', () => {
  test('a second operation is refused while one runs unless it replaces it', async () => {
    const { owner, joiner } = await roomPair();
    expect(await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result')).toMatchObject({ ok: true });
    const busy = await joiner.request({ t: 'lock.acquire', lease: 5, ids: ['b'] }, 'lock.result');
    expect(busy).toMatchObject({ ok: false, code: 'lease_busy' });
    const replaced = await joiner.request({ t: 'lock.acquire', lease: 6, ids: ['b'], replace: true }, 'lock.result');
    expect(replaced).toMatchObject({ ok: true, add: ['b'], remove: ['a'] });
    expect(await owner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('the running lease number extends the operation; used numbers are stale', async () => {
    const { joiner } = await roomPair();
    joiner.lease = 10;
    await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    expect(await joiner.request({ t: 'lock.acquire', ids: ['b'] }, 'lock.result')).toMatchObject({ ok: true });
    const stale = await joiner.request({ t: 'lock.acquire', lease: 9, ids: ['c'], replace: true }, 'lock.result');
    expect(stale).toMatchObject({ ok: false, code: 'lease_stale' });
    await joiner.request({ t: 'lock.release' }, 'lock.result');
    const ended = await joiner.request({ t: 'lock.acquire', lease: 10, ids: ['c'] }, 'lock.result');
    expect(ended).toMatchObject({ ok: false, code: 'lease_stale' });
  });

  test('a lease request for a million ids stops at the per-member cap', async () => {
    const { joiner } = await roomPair();
    let last: any = null;
    for (let chunk = 0; chunk < 6 && last?.ok !== false; chunk++)
      last = await joiner.request({ t: 'lock.acquire', ids: idsMake(`c${chunk}_`, 4096) }, 'lock.result');
    expect(last).toMatchObject({ ok: false, code: 'lock_limit' });
    joiner.sendRaw(JSON.stringify({ t: 'lock.acquire', lease: 99, replace: true, ids: idsMake('x', 4097) }));
    expect(await joiner.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('two tabs of one user are two members with one operation each', async () => {
    const { owner, roomId } = await roomPair();
    const tab = (await testRoomJoinSynced(await connect(), owner, roomId)).joiner;
    const other = (await testRoomJoinSynced(await connect(), owner, roomId)).joiner;
    expect(await tab.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result')).toMatchObject({ ok: true });
    expect(await other.request({ t: 'lock.acquire', ids: ['b'] }, 'lock.result')).toMatchObject({ ok: true });
    const conflict = await other.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    expect(conflict).toMatchObject({ ok: false, code: 'lock_conflict', conflicts: [{ id: 'a', by: tab.user }] });
  });
});

describe('lease expiry', () => {
  test('a frozen holder loses its lease and everybody, the holder too, is told', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    const started = performance.now();
    const seen = await owner.next('locks', (message) => message.expired === true, 2000);
    expect(seen).toMatchObject({ by: joiner.user, remove: ['cube'] });
    expect(performance.now() - started).toBeGreaterThan(300);
    expect(await joiner.next('locks', (message) => message.expired === true)).toMatchObject({ remove: ['cube'] });
    expect(await owner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('renewals keep a held operation alive and edits after expiry are stale', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    await owner.next('locks');
    for (let tick = 0; tick < 6; tick++) {
      await Bun.sleep(150);
      joiner.send({ t: 'lock.renew' });
    }
    expect(owner.has('locks')).toBe(false);
    await owner.next('locks', (message) => message.expired === true, 2000);
    joiner.send({ t: 'edit', seq: 1, lease: joiner.lease, ops: [{ k: 'transform', ids: ['cube'], d: {} }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'lease_stale' });
    expect(joiner.closeCode).toBeNull();
  });

  test('renewals alone stop counting after the idle maximum', async () => {
    const idle = collabServerStart(
      testConfiguration({ lockLeaseMs: 300, lockLeaseSweepMs: 50, lockLeaseIdleMaximumMs: 700 }),
    );
    try {
      const { owner, joiner } = await roomPair(idle);
      await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
      const started = performance.now();
      const timer = setInterval(() => joiner.send({ t: 'lock.renew' }), 100);
      await owner.next('locks', (message) => message.expired === true, 3000);
      clearInterval(timer);
      expect(performance.now() - started).toBeGreaterThan(600);
    } finally {
      await idle.stop();
    }
  });
});

describe('edits and leases', () => {
  test('edits of a running operation must stay inside its lease', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, lease: joiner.lease, ops: [{ k: 'transform', ids: ['a'], d: {} }] });
    joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'delete', ids: ['b'] }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'outside_lease', ids: ['b'] });
    const edits = await owner.next('edits');
    expect(edits.list.map((entry: { seq: number }) => entry.seq)).toEqual([1]);
  });

  test('an edit sent before the release is accepted; one after it is stale', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    const lease = joiner.lease;
    joiner.send({ t: 'edit', seq: 1, lease, ops: [{ k: 'transform', ids: ['a'], d: {} }] });
    joiner.send({ t: 'lock.release' });
    joiner.send({ t: 'edit', seq: 2, lease, ops: [{ k: 'transform', ids: ['a'], d: {} }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'lease_stale' });
    expect((await owner.next('edits')).list[0].seq).toBe(1);
  });

  test('a lease number never issued is stale and counts as misuse', async () => {
    const { joiner } = await roomPair();
    joiner.send({ t: 'edit', seq: 1, lease: 777, ops: [{ k: 'transform', ids: ['a'], d: {} }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ reason: 'lease_stale' });
    expect(scoreOf(joiner)).toBeGreaterThan(0.5);
  });

  test('objects duplicated during a drag join the lease; deleted ones leave it', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, lease: joiner.lease, ops: [{ k: 'create', ids: ['copy'], d: {} }] });
    expect(await owner.next('locks', (message) => message.add?.includes('copy'))).toMatchObject({ by: joiner.user });
    joiner.send({ t: 'edit', seq: 2, lease: joiner.lease, ops: [{ k: 'delete', ids: ['copy'] }] });
    expect(await owner.next('locks', (message) => message.remove?.includes('copy'))).toMatchObject({ by: joiner.user });
  });

  test('one-shot edits are rate limited per member', async () => {
    const { joiner } = await roomPair();
    for (let seq = 1; seq <= 90; seq++)
      joiner.send({ t: 'edit', seq, ops: [{ k: 'property', ids: ['a'], d: { f: { name: `n${seq}` } } }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ reason: 'rate_limited' });
  });

  test('a giant delete counts against the bulk id budget', async () => {
    const bulk = collabServerStart(testConfiguration({ bulkIdsPerSecond: 10, bulkIdBurst: 5000 }));
    try {
      const { joiner } = await roomPair(bulk);
      joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'delete', ids: idsMake('d', 4000) }] });
      joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'delete', ids: idsMake('e', 4000) }] });
      expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'rate_limited' });
    } finally {
      await bulk.stop();
    }
  });
});

describe('selection presence', () => {
  test('selections are relayed to the others without locking', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({ t: 'select', ids: ['cube', 'group'] });
    expect(await owner.next('selected')).toMatchObject({ by: joiner.user, ids: ['cube', 'group'] });
    expect(await owner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result')).toMatchObject({ ok: true });
    expect(joiner.has('selected')).toBe(false);
  });

  test('selection floods are dropped without closing', async () => {
    const { owner, joiner } = await roomPair();
    for (let index = 0; index < 100; index++) joiner.send({ t: 'select', ids: [`o${index}`] });
    await Bun.sleep(200);
    let count = 0;
    while (owner.has('selected')) {
      await owner.next('selected');
      count++;
    }
    expect(count).toBeLessThan(40);
    expect(joiner.closeCode).toBeNull();
  });
});

describe('abuse', () => {
  test('acquire churn is rate limited and then throttled', async () => {
    const { joiner } = await roomPair();
    const codes: string[] = [];
    for (let lease = 2; lease < 60; lease++) {
      const reply = await joiner.request({ t: 'lock.acquire', lease, ids: ['a'], replace: true }, 'lock.result');
      codes.push(reply.ok ? 'ok' : reply.code);
    }
    expect(codes).toContain('rate_limited');
    expect(codes.at(-1)).toBe('throttled');
    expect(joiner.closeCode).toBeNull();
  });

  test('acquires that keep coming while throttled escalate to a close', async () => {
    const { joiner } = await roomPair();
    for (let lease = 2; lease < 200 && joiner.closeCode === null; lease++)
      joiner.send({ t: 'lock.acquire', r: lease, lease, ids: ['a'], replace: true });
    expect(await joiner.closed()).toBe(CLOSE_CODES.abuse);
  });

  test('renewal floods close the connection, flag it and keep the address out of the room', async () => {
    const { owner, joiner, roomId } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['a'] }, 'lock.result');
    for (let index = 0; index < 200; index++) joiner.send({ t: 'lock.renew' });
    expect(await joiner.closed()).toBe(CLOSE_CODES.abuse);
    const room = server.core.registry.get(roomId);
    expect(room?.abuseFlags.at(-1)).toMatchObject({ user: joiner.user, closed: true });
    await owner.next('locks', (message) => message.by === joiner.user && message.remove?.includes('a'));
    const again = await connect();
    expect(again.welcome.user).toBeGreaterThan(0);
    const join = await again.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    expect(join).toMatchObject({ t: 'error', code: 'too_many_attempts' });
    const fresh = await roomCreate(again);
    expect(fresh.length).toBeGreaterThan(0);
    expect(scoreOf(again)).toBeLessThan(server.core.config.abuseThrottleScore);
  });

  test('honest drags never earn misuse points', async () => {
    const { owner, joiner } = await roomPair();
    const before = scoreOf(joiner);
    for (let drag = 0; drag < 8; drag++) await honestDrag(joiner, drag * 20);
    await Bun.sleep(100);
    expect(joiner.has('edit.rejected')).toBe(false);
    expect(before).toBeGreaterThanOrEqual(0);
    expect(scoreOf(joiner)).toBeLessThanOrEqual(before);
    expect(owner.closeCode).toBeNull();
  });
});
