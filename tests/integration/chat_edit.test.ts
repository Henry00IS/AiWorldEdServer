/**
 * Chat edits (capability `chat.edit`): only the sender, only for a few minutes,
 * a bounded number of times and at a bounded rate; the text is normalized like
 * a new message and members without the capability never see edits.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import {
  CHAT_EDIT_INTERVAL_MS,
  CHAT_EDIT_WINDOW_MS,
  CHAT_EDITS_PER_MESSAGE_MAXIMUM,
} from '../../src/shared/chat_text_policy.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';

const CAPS = ['select', 'chat.edit'];
let server: CollabServer;
const clients: TestClient[] = [];

beforeAll(() => {
  server = collabServerStart(testConfiguration({ connectionsPerIp: 200, chatIntervalMs: 50 }));
});

afterEach(async () => {
  setSystemTime();
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects a tracked client.
 *
 * @param name Display name.
 * @param caps Capabilities to announce.
 * @returns Connected client.
 */
async function connect(name: string, caps: string[] = CAPS): Promise<TestClient> {
  const client = await TestClient.connect(server.port, { name, caps });
  clients.push(client);
  return client;
}

/**
 * Creates a room with an owner and synced members.
 *
 * @param members Display name and capabilities of each member.
 * @returns Owner and members in order.
 */
async function roomWith(...members: Array<[string, string[]?]>): Promise<TestClient[]> {
  const owner = await connect('Owner');
  const roomId = await roomCreate(owner);
  const joined = [owner];
  for (const [name, caps] of members) {
    const member = await connect(name, caps ?? CAPS);
    await testRoomJoinSynced(member, owner, roomId);
    joined.push(member);
  }
  return joined;
}

/**
 * Sends a chat edit and waits for its reply or error.
 *
 * @param client Editor.
 * @param id Message id.
 * @param text New text.
 * @returns Reply or error.
 */
function chatEdit(client: TestClient, id: number, text: string): Promise<TestMessage> {
  return client.request({ t: 'chat.edit', id, text }, 'chat.edited');
}

/**
 * Sends a chat message and returns its id.
 *
 * @param client Sender.
 * @param text Text.
 * @returns Message id.
 */
async function chatSend(client: TestClient, text: string): Promise<number> {
  const sent = await client.request({ t: 'chat', text }, 'chat.sent');
  return Number(sent.id);
}

describe('chat edits', () => {
  test('the welcome offers chat.edit when asked for', async () => {
    const client = await connect('Caps');
    expect(client.welcome.caps).toContain('chat.edit');
  });

  test('the sender edits its message; capable members get the normalized text after the message', async () => {
    const [owner, bob, old] = (await roomWith(['Bob'], ['Old', ['select']])) as [TestClient, TestClient, TestClient];
    const id = await chatSend(owner, 'helo');
    const reply = await chatEdit(owner, id, '  hello\u200B ');
    expect(reply).toMatchObject({ t: 'chat.edited', id, from: owner.user, text: 'hello' });
    expect(await bob.next('chat')).toMatchObject({ id, text: 'helo' });
    expect(await bob.next('chat.edited')).toEqual({
      t: 'chat.edited',
      id,
      from: owner.user,
      text: 'hello',
      at: reply.at,
    });
    expect(await old.next('chat')).toMatchObject({ id });
    await Bun.sleep(50);
    expect(old.has('chat.edited')).toBe(false);
  });

  test('nobody else may edit a message', async () => {
    const [owner, bob] = (await roomWith(['Bob'])) as [TestClient, TestClient];
    const id = await chatSend(bob, 'mine');
    expect(await chatEdit(owner, id, 'stolen')).toMatchObject({
      t: 'error',
      code: 'chat_edit_refused',
      reason: 'not_author',
    });
    await Bun.sleep(50);
    expect(bob.has('chat.edited')).toBe(false);
  });

  test('a message can no longer be edited after the edit window', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    const id = await chatSend(owner, 'soon old');
    setSystemTime(new Date(Date.now() + CHAT_EDIT_WINDOW_MS + 1000));
    expect(await chatEdit(owner, id, 'too late')).toMatchObject({ code: 'chat_edit_refused', reason: 'expired' });
  });

  test('unknown messages are refused', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    expect(await chatEdit(owner, 99, 'nothing')).toMatchObject({ code: 'chat_edit_refused', reason: 'not_found' });
  });

  test('edits are rate limited and capped per message', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    const id = await chatSend(owner, 'v0');
    let now = Date.now();
    expect((await chatEdit(owner, id, 'v1')).t).toBe('chat.edited');
    const limited = await chatEdit(owner, id, 'fast');
    expect(limited).toMatchObject({ code: 'chat_rate_limited' });
    expect(Number(limited.retryAfterMs)).toBeGreaterThan(0);
    for (let edit = 2; edit <= CHAT_EDITS_PER_MESSAGE_MAXIMUM; edit++) {
      now += CHAT_EDIT_INTERVAL_MS;
      setSystemTime(new Date(now));
      expect((await chatEdit(owner, id, `v${edit}`)).t).toBe('chat.edited');
    }
    setSystemTime(new Date(now + CHAT_EDIT_INTERVAL_MS));
    expect(await chatEdit(owner, id, 'one more')).toMatchObject({ code: 'chat_edit_refused', reason: 'too_many' });
  });

  test('an empty or overlong edit is refused like a message', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    const id = await chatSend(owner, 'text');
    expect(await chatEdit(owner, id, '\u200B')).toMatchObject({ code: 'invalid_chat', reason: 'empty' });
    expect(await chatEdit(owner, id, 'x'.repeat(2001))).toMatchObject({ code: 'invalid_chat', reason: 'too_long' });
  });

  test('a connection without chat.edit cannot edit', async () => {
    const [, old] = (await roomWith(['Old', ['select']])) as [TestClient, TestClient];
    const id = await chatSend(old, 'old client');
    expect(await chatEdit(old, id, 'new')).toMatchObject({ code: 'chat_edit_refused', reason: 'unsupported' });
  });

  test('a rejoined sender is a new connection and cannot edit its old messages', async () => {
    const owner = await connect('Owner');
    const roomId = await roomCreate(owner);
    const { joiner: first } = await testRoomJoinSynced(await connect('Ann'), owner, roomId);
    const id = await chatSend(first, 'before');
    first.close();
    const { joiner: again } = await testRoomJoinSynced(await connect('Ann'), owner, roomId);
    expect(await chatEdit(again, id, 'after')).toMatchObject({ code: 'chat_edit_refused', reason: 'not_author' });
  });

  test('outside a room and malformed edits are refused', async () => {
    const client = await connect('Alone');
    expect(await chatEdit(client, 1, 'x')).toMatchObject({ code: 'not_in_room' });
    client.send({ t: 'chat.edit', id: 0, text: 'x' });
    expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
  });
});
