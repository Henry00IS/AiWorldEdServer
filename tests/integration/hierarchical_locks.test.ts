/**
 * End-to-end tests of hierarchical locks against a real local relay: shared
 * locks on ancestors keep containers from being taken while something inside
 * them is edited, and creates or reparents into a container another member
 * holds are rejected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
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

beforeAll(() => {
  server = collabServerStart(testConfiguration());
  port = server.port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

describe('hierarchical locks', () => {
  test('a container cannot be locked while a member edits something inside it', async () => {
    const { owner, joiner } = await roomPair();
    const pending = joiner.request({ t: 'lock.acquire', ids: ['cube'], shared: ['group'] }, 'lock.result');
    expect(await verifyAnswer(owner)).toMatchObject({ ids: ['cube'], anc: ['group'] });
    const granted = await pending;
    expect(granted).toMatchObject({ ok: true, add: ['cube'] });
    const refused = await owner.request({ t: 'lock.acquire', ids: ['group', 'sphere'], replace: true }, 'lock.result');
    expect(refused).toMatchObject({
      ok: false,
      code: 'lock_conflict',
      conflicts: [{ id: 'group', by: joiner.user, shared: true }],
    });
    const sibling = await owner.request({ t: 'lock.acquire', ids: ['sphere'], shared: ['group'] }, 'lock.result');
    expect(sibling).toMatchObject({ ok: true });
    await joiner.request({ t: 'lock.acquire', ids: ['other'], replace: true }, 'lock.result');
    await owner.request({ t: 'lock.release' }, 'lock.result');
    expect(await owner.request({ t: 'lock.acquire', ids: ['group'] }, 'lock.result')).toMatchObject({ ok: true });
  });

  test('reparenting into a container another member holds is rejected', async () => {
    const { owner, joiner } = await roomPair();
    await owner.request({ t: 'lock.acquire', ids: ['group'] }, 'lock.result');
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'reparent', ids: ['cube'], d: {}, p: ['group', 'world'] }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 1, reason: 'lock_conflict', ids: ['group'] });
    joiner.send({ t: 'edit', seq: 2, ops: [{ k: 'create', ids: ['new1'], d: {}, p: ['group'] }] });
    expect(await joiner.next('edit.rejected')).toMatchObject({ seq: 2, reason: 'lock_conflict', ids: ['group'] });
    expect(owner.has('edits')).toBe(false);
  });

  test('an accepted reparent shares the new parent chain with the sender', async () => {
    const { owner, joiner } = await roomPair();
    await joiner.request({ t: 'lock.acquire', ids: ['cube'] }, 'lock.result');
    joiner.send({ t: 'edit', seq: 1, ops: [{ k: 'reparent', ids: ['cube'], d: {}, p: ['group'] }] });
    expect(await verifyAnswer(owner)).toMatchObject({ ids: ['group'], anc: [] });
    expect((await owner.next('edits')).list[0].ops[0].p).toEqual(['group']);
    const refused = await owner.request({ t: 'lock.acquire', ids: ['group'] }, 'lock.result');
    expect(refused).toMatchObject({ ok: false, conflicts: [{ id: 'group', by: joiner.user, shared: true }] });
  });

  test('creating inside a container created in the same edit is accepted', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({
      t: 'edit',
      seq: 1,
      ops: [
        { k: 'create', ids: ['box'], d: {} },
        { k: 'create', ids: ['inner'], d: {}, p: ['box'] },
      ],
    });
    expect((await owner.next('edits')).list[0].ops.length).toBe(2);
  });
});
