/**
 * End-to-end tests of protocol negotiation: version ranges, capability flags,
 * extension objects, room versions in the room list and joins of a room made
 * with another version.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES, PROTOCOL_ID } from '../../src/shared/protocol_definitions.ts';
import { PROTOCOL_GOLDEN_VECTORS_V2 } from '../../src/shared/protocol_golden_vectors.ts';
import { TestClient, TEST_COMPATIBILITY_IDENTITY } from '../support/test_client.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
const clients: TestClient[] = [];

/**
 * Connects a client without hello; it is closed after the test.
 *
 * @returns Connected client.
 */
async function connectBare(): Promise<TestClient> {
  const client = await TestClient.connect(server.port, { hello: false });
  clients.push(client);
  return client;
}

/**
 * Sends a hello with the given extra fields.
 *
 * @param client Client.
 * @param fields Fields added to a minimal hello.
 */
function helloSend(client: TestClient, fields: Record<string, unknown>): void {
  client.send({ t: 'hello', protocol: PROTOCOL_ID, version: 2, client: 'AiWorldEd/9.9', ...fields });
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

test('an old editor gets a readable refusal before the socket closes', async () => {
  const client = await connectBare();
  helloSend(client, { version: 1 });
  const refusal = await client.next('error');
  expect(refusal).toMatchObject({ code: 'protocol_unsupported', versions: { min: 2, max: 2 } });
  expect(refusal.message).toContain('Update your editor');
  expect(await client.closed()).toBe(CLOSE_CODES.protocolUnsupported);
});

test('a newer editor that still speaks this version is served with it', async () => {
  const client = await connectBare();
  helloSend(client, { version: 7, minVersion: 1 });
  expect(await client.next('welcome')).toMatchObject({ version: 2, versions: { min: 2, max: 2 } });
  const strict = await connectBare();
  helloSend(strict, { version: 7, minVersion: 5 });
  expect((await strict.next('error')).message).toContain('This server needs an update');
});

test('capabilities are agreed and unknown ones are ignored', async () => {
  const client = await connectBare();
  helloSend(client, { caps: ['future.thing', 'select'] });
  expect((await client.next('welcome')).caps).toEqual(['select']);
  const none = await connectBare();
  helloSend(none, {});
  expect((await none.next('welcome')).caps).toEqual([]);
});

test('extension objects accept unknown keys; anything else stays strict', async () => {
  const client = await connectBare();
  helloSend(client, { x: { 'studio.build': 'nb-42', telemetry: { on: false } } });
  expect((await client.next('welcome')).version).toBe(2);
  const badKey = await connectBare();
  helloSend(badKey, { x: { 'Bad Key': 1 } });
  expect(await badKey.closed()).toBe(CLOSE_CODES.protocolViolation);
  const unknownField = await connectBare();
  helloSend(unknownField, { futureField: 1 });
  expect(await unknownField.closed()).toBe(CLOSE_CODES.protocolViolation);
});

test('members without the select capability get no selections', async () => {
  const owner = await TestClient.connect(server.port);
  clients.push(owner);
  const roomId = await roomCreate(owner);
  const plain = await connectBare();
  helloSend(plain, {});
  plain.user = (await plain.next('welcome')).user;
  await testRoomJoinSynced(plain, owner, roomId);
  plain.send({ t: 'select', ids: ['cube'] });
  expect(await owner.next('selected')).toMatchObject({ by: plain.user, ids: ['cube'] });
  owner.send({ t: 'select', ids: ['cube'] });
  await Bun.sleep(100);
  expect(plain.has('selected')).toBe(false);
});

test('the room list shows the protocol and editor a room was made with', async () => {
  const owner = await TestClient.connect(server.port);
  clients.push(owner);
  const roomId = await roomCreate(owner, { internalTest: false });
  const list = await owner.request({ t: 'room.list' }, 'room.list');
  const entry = list.rooms.find((room: { id: string }) => room.id === roomId);
  expect(entry).toMatchObject({ protocol: 2, editor: 'aiworlded-tests/1' });
});

test('joining a room made with another protocol version explains the mismatch', async () => {
  const owner = await TestClient.connect(server.port);
  clients.push(owner);
  const roomId = await roomCreate(owner);
  const room = server.core.registry.get(roomId) as unknown as { protocol: object };
  room.protocol = { version: 1, caps: new Set(), client: 'AiWorldEd/0.1' };
  const joiner = await TestClient.connect(server.port);
  clients.push(joiner);
  const reply = await joiner.request(
    { t: 'room.join', compatibility: TEST_COMPATIBILITY_IDENTITY, room: roomId, discardLocalWork: true },
    'room.joined',
  );
  expect(reply).toMatchObject({ t: 'error', code: 'protocol_mismatch', roomProtocol: 1, yourProtocol: 2 });
  expect(reply.message).toBe('This room uses protocol v1; your editor speaks v2. Update or join a compatible room.');
});

test('the relay emits the recorded golden welcome shape', async () => {
  const client = await connectBare();
  helloSend(client, { caps: ['select'] });
  const welcome = await client.next('welcome');
  const vector = PROTOCOL_GOLDEN_VECTORS_V2.server.find((entry) => entry.name === 'welcome');
  const golden = JSON.parse(vector?.frame ?? 'null');
  expect({ ...welcome, user: 1 }).toMatchObject(golden);
});
