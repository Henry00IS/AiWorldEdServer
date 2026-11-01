/**
 * Rate, connection and snapshot timeout limits on dedicated server instances
 * with small budgets.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;

beforeAll(() => {
  server = collabServerStart(testConfiguration({ messagesPerSecond: 5, messageBurst: 10, connectionsPerIp: 3 }));
});

afterAll(async () => {
  await server.stop();
});

test('flooding messages closes the connection', async () => {
  const client = await TestClient.connect(server.port);
  for (let index = 0; index < 50; index++) client.send({ t: 'ping' });
  expect(await client.closed()).toBe(CLOSE_CODES.rateLimited);
});

test('connections per IP are capped', async () => {
  const open = [
    await TestClient.connect(server.port),
    await TestClient.connect(server.port),
    await TestClient.connect(server.port),
  ];
  await expect(TestClient.connect(server.port)).rejects.toThrow();
  for (const client of open) client.close();
});

test('a joiner whose snapshot never arrives is removed after the timeout', async () => {
  const quick = collabServerStart(testConfiguration({ snapshotTimeoutMs: 200 }));
  const owner = await TestClient.connect(quick.port);
  const created = await owner.request(
    { t: 'room.create', name: 'timeout', private: false, internalTest: true },
    'room.created',
  );
  const joiner = await TestClient.connect(quick.port);
  await joiner.request({ t: 'room.join', room: created.room.id, discardLocalWork: true }, 'room.joined');
  expect((await joiner.next('room.left')).reason).toBe('snapshot_timeout');
  expect((await owner.next('member.left')).user).toBe(joiner.user);
  owner.close();
  joiner.close();
  await quick.stop();
});
