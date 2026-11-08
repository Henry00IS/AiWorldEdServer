/**
 * End-to-end tests of chat typing presence: signals, countdown expiry, leave
 * clearing, and the `typing` capability gate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient } from '../support/test_client.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
const clients: TestClient[] = [];

/**
 * Connects a client that is closed after the test.
 *
 * @param caps Capabilities to announce.
 * @returns Connected client.
 */
async function connect(caps: string[] = ['select', 'typing']): Promise<TestClient> {
  const client = await TestClient.connect(server.port, { caps });
  clients.push(client);
  return client;
}

/**
 * Creates a room with one synced joiner that both speak typing.
 *
 * @returns Owner, joiner and room id.
 */
async function roomPair(): Promise<{ owner: TestClient; joiner: TestClient; roomId: string }> {
  const owner = await connect();
  const roomId = await roomCreate(owner);
  const { joiner } = await testRoomJoinSynced(await connect(), owner, roomId);
  return { owner, joiner, roomId };
}

beforeAll(async () => {
  server = await collabServerStart(testConfiguration({ typingExpiryMs: 200 }));
});

afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
});

afterAll(async () => {
  await server.stop();
});

describe('typing presence', () => {
  test('a typing signal is broadcast as the list of typing user ids', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [joiner.user] });
    // Sender must not see their own id.
    expect(await joiner.next('typing')).toMatchObject({ users: [] });
  });

  test('each recipient omits their own user id from the typing list', async () => {
    const { owner, joiner, roomId } = await roomPair();
    const third = await connect();
    await testRoomJoinSynced(third, owner, roomId);
    owner.send({ t: 'typing' });
    expect(await joiner.next('typing')).toMatchObject({ users: [owner.user] });
    expect(await third.next('typing')).toMatchObject({ users: [owner.user] });
    expect(await owner.next('typing')).toMatchObject({ users: [] });
    joiner.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [joiner.user] });
    expect(await third.next('typing')).toMatchObject({
      users: [owner.user, joiner.user].sort((a, b) => a - b),
    });
    expect(await joiner.next('typing')).toMatchObject({ users: [owner.user] });
  });

  test('another signal resets the countdown without a duplicate start broadcast', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [joiner.user] });
    while (owner.has('typing')) await owner.next('typing');
    joiner.send({ t: 'typing' });
    await Bun.sleep(50);
    expect(owner.has('typing')).toBe(false);
    await Bun.sleep(250);
    expect(await owner.next('typing')).toMatchObject({ users: [] });
  });

  test('stop clears the flag immediately', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [joiner.user] });
    joiner.send({ t: 'typing', stop: true });
    expect(await owner.next('typing')).toMatchObject({ users: [] });
  });

  test('leaving clears typing before or with the leave, never after', async () => {
    const { owner, joiner } = await roomPair();
    joiner.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [joiner.user] });
    joiner.send({ t: 'room.leave' });
    const typing = await owner.next('typing');
    const left = await owner.next('member.left');
    expect(typing).toMatchObject({ users: [] });
    expect(left).toMatchObject({ user: joiner.user });
  });

  test('members without the typing capability get no typing broadcasts', async () => {
    const owner = await connect(['select', 'typing']);
    const roomId = await roomCreate(owner);
    const plain = await connect(['select']);
    clients.push(plain);
    await testRoomJoinSynced(plain, owner, roomId);
    const capable = await connect(['select', 'typing']);
    await testRoomJoinSynced(capable, owner, roomId);
    capable.send({ t: 'typing' });
    expect(await owner.next('typing')).toMatchObject({ users: [capable.user] });
    expect(await capable.next('typing')).toMatchObject({ users: [] });
    await Bun.sleep(50);
    expect(plain.has('typing')).toBe(false);
  });
});
