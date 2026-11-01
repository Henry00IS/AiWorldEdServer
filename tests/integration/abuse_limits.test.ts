/**
 * Regression tests for the 2026-11-01 security audit: per-address limits that
 * keep one attacker from exhausting shared relay resources.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration, TEST_DUMMY_FORWARDED_SECRET } from '../support/test_configuration.ts';

const STRONG_PASSWORD = 'Qv7#mLp2!xRt9zK';

let server: CollabServer;

beforeAll(() => {
  server = collabServerStart(testConfiguration({ passwordHashConcurrency: 4, passwordHashConcurrencyPerIp: 1 }));
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects as if forwarded by the trusted proxy for the given client address.
 *
 * @param clientIp Address the proxy reports in X-Real-IP.
 * @param port Relay port (defaults to the shared test relay).
 * @returns Connected client after hello.
 */
async function connectFrom(clientIp: string, port = server.port): Promise<TestClient> {
  return TestClient.connect(port, {
    headers: { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': clientIp },
  });
}

/**
 * Sends a private room creation request.
 *
 * @param client Creator.
 * @param requestId Request id.
 */
function privateCreateSend(client: TestClient, requestId: number): void {
  client.send({ t: 'room.create', r: requestId, name: 'private', private: true, password: STRONG_PASSWORD });
}

/**
 * Waits for the reply (room.created or error) to a request.
 *
 * @param client Requester.
 * @param requestId Request id.
 * @returns Reply message.
 */
async function replyTo(client: TestClient, requestId: number): Promise<any> {
  return client.next(
    '*',
    (message) => message.r === requestId && (message.t === 'room.created' || message.t === 'error'),
    10_000,
  );
}

test('one address cannot hold more password hashing slots than its share', async () => {
  const sameAddress = [await connectFrom('203.0.113.10'), await connectFrom('203.0.113.10')];
  const otherAddress = await connectFrom('198.51.100.20');
  sameAddress.forEach((client, index) => privateCreateSend(client, index + 1));
  privateCreateSend(otherAddress, 9);
  const replies = await Promise.all(sameAddress.map((client, index) => replyTo(client, index + 1)));
  expect(replies.map((reply) => reply.t === 'error' && reply.code).sort()).toEqual(['busy', false]);
  expect((await replyTo(otherAddress, 9)).t).toBe('room.created');
  [...sameAddress, otherAddress].forEach((client) => client.close());
});

/**
 * Sends a request and returns the error code it was answered with.
 *
 * @param client Requester.
 * @param message Request including its request id `r`.
 * @returns Error code.
 */
async function errorCodeFor(client: TestClient, message: { r: number } & Record<string, unknown>): Promise<string> {
  client.send(message);
  return (await client.next('error', (reply) => reply.r === message.r)).code;
}

/**
 * Sends four joins to a missing room and one public create.
 *
 * @param client Requester.
 * @returns Error codes of the five replies, in order.
 */
async function roomEntryErrorCodes(client: TestClient): Promise<string[]> {
  const codes = [];
  for (let requestId = 1; requestId <= 4; requestId++)
    codes.push(
      await errorCodeFor(client, { t: 'room.join', r: requestId, room: 'A'.repeat(16), discardLocalWork: true }),
    );
  codes.push(await errorCodeFor(client, { t: 'room.create', r: 5, name: 'more', private: false }));
  return codes;
}

test('room create and join requests are rate limited per address', async () => {
  const limited = collabServerStart(testConfiguration({ roomEntriesPerIpPerMinute: 1, roomEntryBurstPerIp: 3 }));
  const attacker = await connectFrom('203.0.113.30', limited.port);
  const bystander = await connectFrom('198.51.100.40', limited.port);
  const notFound = 'room_not_found';
  const limitedCode = 'too_many_attempts';
  expect(await roomEntryErrorCodes(attacker)).toEqual([notFound, notFound, notFound, limitedCode, limitedCode]);
  const created = await bystander.request({ t: 'room.create', name: 'fine', private: false }, 'room.created');
  expect(created.t).toBe('room.created');
  expect(attacker.welcome.limits.roomEntriesPerIpPerMinute).toBe(1);
  attacker.close();
  bystander.close();
  await limited.stop();
});
