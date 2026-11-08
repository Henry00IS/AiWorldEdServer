/**
 * Development relay option INTERNAL_TEST_ROOMS_VIA_PROXY: proxied connections
 * may use hidden internal test rooms.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient, TEST_COMPATIBILITY_IDENTITY } from '../support/test_client.ts';
import { TEST_DUMMY_FORWARDED_SECRET, testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;

beforeAll(() => {
  server = collabServerStart(testConfiguration({ internalTestRoomsViaProxy: true, websocketPath: '/wstest' }));
});

afterAll(() => server.stop());

/**
 * Builds headers that look like a request forwarded by the proxy with the dummy
 * secret.
 *
 * @param clientIp Forwarded client address.
 * @returns Request headers.
 */
function proxiedHeaders(clientIp: string): Record<string, string> {
  return { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': clientIp, 'X-Forwarded-For': clientIp };
}

describe('internal test rooms via proxy (development relay)', () => {
  test('the configured WebSocket path is served and /ws is not', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/ws`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/wstest`)).status).not.toBe(404);
  });

  test('proxied connections can create, list and join internal test rooms', async () => {
    const owner = await TestClient.connect(server.port, { headers: proxiedHeaders('203.0.113.80'), path: '/wstest' });
    expect(owner.welcome.via).toBe('proxy');
    const created = await owner.request(
      { t: 'room.create', name: 'proxied test', private: false, internalTest: true },
      'room.created',
    );
    expect(created.t).toBe('room.created');
    const joiner = await TestClient.connect(server.port, { headers: proxiedHeaders('203.0.113.81'), path: '/wstest' });
    const list = await joiner.request({ t: 'room.list' }, 'room.list');
    expect(list.rooms.some((room: { id: string }) => room.id === created.room.id)).toBe(true);
    const joined = await joiner.request(
      { t: 'room.join', compatibility: TEST_COMPATIBILITY_IDENTITY, room: created.room.id, discardLocalWork: true },
      'room.joined',
    );
    expect(joined.t).toBe('room.joined');
    owner.close();
    joiner.close();
  });
});
