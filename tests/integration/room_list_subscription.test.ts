/**
 * Live room list over real WebSockets: `room.subscribe` returns the full list,
 * `room.list.update` pushes report created rooms (with the owner's display
 * name), member count changes and closed rooms, and unsubscribing or
 * disconnecting ends the pushes. Internal test rooms never reach proxied
 * subscribers, even on a relay that lets proxied clients use them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { snapshotSend } from '../support/test_room.ts';
import { TEST_DUMMY_FORWARDED_SECRET, testConfiguration } from '../support/test_configuration.ts';

let server: CollabServer;
const clients: TestClient[] = [];

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({ roomListPushIntervalMs: 20, roomListSubscribersMaximum: 3, internalTestRoomsViaProxy: true }),
  );
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await subscriptionsDrained();
});

/**
 * Waits until the relay noticed every closed subscriber, so each test starts
 * with an empty subscription table.
 */
async function subscriptionsDrained(): Promise<void> {
  for (let attempt = 0; attempt < 500 && server.core.roomListSubscriptions.size() > 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(server.core.roomListSubscriptions.size()).toBe(0);
}

afterAll(() => server.stop());

/**
 * Connects a client that is closed after the test.
 *
 * @param name Display name sent in hello.
 * @param clientIp Forwarded address; when set, the client looks proxied.
 * @returns Connected client.
 */
async function connect(name: string, clientIp?: string): Promise<TestClient> {
  const headers = clientIp
    ? { 'X-Forwarded-Secret': TEST_DUMMY_FORWARDED_SECRET, 'X-Real-IP': clientIp, 'X-Forwarded-For': clientIp }
    : undefined;
  const client = await TestClient.connect(server.port, { name, ...(headers ? { headers } : {}) });
  clients.push(client);
  return client;
}

/**
 * Waits for an update that mentions a room id (as entry or removal).
 *
 * @param client Subscriber.
 * @param predicate Update filter.
 * @returns Matching update.
 */
function updateNext(client: TestClient, predicate: (update: TestMessage) => boolean): Promise<TestMessage> {
  return client.next('room.list.update', predicate);
}

describe('live room list subscription', () => {
  test('welcome announces the list limits', async () => {
    const client = await connect('Probe');
    expect(client.welcome.limits.roomListMaximum).toBe(server.core.config.roomListMaximum);
    expect(client.welcome.limits.roomListPushIntervalMs).toBe(20);
  });

  test('created, joined, left and closed rooms are pushed with the owner name', async () => {
    const watcher = await connect('Watcher');
    const subscribed = await watcher.request({ t: 'room.subscribe' }, 'room.subscribed');
    expect(Array.isArray(subscribed.rooms)).toBe(true);
    const owner = await connect('Henry');
    const created = await owner.request({ t: 'room.create', name: 'Awesome room', private: false }, 'room.created');
    const roomId = created.room.id;
    const added = await updateNext(watcher, (update) => update.rooms.some((room: any) => room.id === roomId));
    expect(added.rooms.find((room: any) => room.id === roomId)).toMatchObject({ owner: 'Henry', users: 1 });
    const joiner = await connect('Guest');
    await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true }, 'room.joined');
    await snapshotSend(owner, new TextEncoder().encode('{}'));
    await updateNext(watcher, (update) => update.rooms.some((room: any) => room.id === roomId && room.users === 2));
    joiner.send({ t: 'room.leave' });
    await updateNext(watcher, (update) => update.rooms.some((room: any) => room.id === roomId && room.users === 1));
    owner.send({ t: 'room.leave' });
    await updateNext(watcher, (update) => update.removed.includes(roomId));
  });

  test('unsubscribe and disconnect end the subscription', async () => {
    const watcher = await connect('Watcher');
    await watcher.request({ t: 'room.subscribe' }, 'room.subscribed');
    expect(server.core.roomListSubscriptions.size()).toBe(1);
    expect((await watcher.request({ t: 'room.unsubscribe' }, 'room.unsubscribed')).t).toBe('room.unsubscribed');
    expect(server.core.roomListSubscriptions.size()).toBe(0);
    await watcher.request({ t: 'room.subscribe' }, 'room.subscribed');
    watcher.close();
    await watcher.closed();
    await subscriptionsDrained();
  });

  test('the subscriber limit is reported as subscription_limit', async () => {
    const watchers = await Promise.all(['A', 'B', 'C', 'D'].map((name) => connect(name)));
    const replies = [];
    for (const watcher of watchers) replies.push(await watcher.request({ t: 'room.subscribe' }, 'room.subscribed'));
    expect(replies.slice(0, 3).every((reply) => reply.t === 'room.subscribed')).toBe(true);
    expect(replies[3]).toMatchObject({ t: 'error', code: 'subscription_limit' });
  });

  test('internal test rooms are never pushed to proxied subscribers', async () => {
    const proxied = await connect('Proxied', '203.0.113.90');
    expect(proxied.welcome.via).toBe('proxy');
    const subscribed = await proxied.request({ t: 'room.subscribe' }, 'room.subscribed');
    expect(subscribed.rooms.length).toBe(0);
    const owner = await connect('Owner');
    const hidden = await owner.request(
      { t: 'room.create', name: 'hidden', private: false, internalTest: true },
      'room.created',
    );
    const visibleOwner = await connect('Visible');
    const visible = await visibleOwner.request({ t: 'room.create', name: 'visible', private: false }, 'room.created');
    const update = await updateNext(proxied, (message) =>
      message.rooms.some((room: any) => room.id === visible.room.id),
    );
    expect(update.rooms.some((room: any) => room.id === hidden.room.id)).toBe(false);
    expect(proxied.has('room.list.update')).toBe(false);
  });

  test('room.subscribe with extra fields is a protocol violation', async () => {
    const client = await connect('Strict');
    client.send({ t: 'room.subscribe', everything: true });
    expect(await client.closed()).toBe(4001);
  });
});
