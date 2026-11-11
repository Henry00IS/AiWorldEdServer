/**
 * Chat reactions (capability `chat.react`): one emoji at a time on a recent
 * message, capped per message and per member, rate limited, relayed only on a
 * change and never to members without the capability.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import {
  CHAT_REACTION_AGE_MAXIMUM_MS,
  CHAT_REACTION_EMOJIS_PER_MESSAGE_MAXIMUM,
  CHAT_REACTION_WINDOW_MS,
  CHAT_REACTIONS_PER_MEMBER_MAXIMUM,
  CHAT_REACTIONS_PER_WINDOW,
} from '../../src/shared/chat_text_policy.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient, type TestMessage } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate, testRoomJoinSynced } from '../support/test_room.ts';

const CAPS = ['select', 'chat.react'];
const EMOJI = [
  '😀',
  '😁',
  '😂',
  '🤣',
  '😃',
  '😄',
  '😅',
  '😆',
  '😉',
  '😊',
  '😋',
  '😎',
  '😍',
  '😘',
  '🥰',
  '😗',
  '😙',
  '🥲',
  '😚',
  '🙂',
  '🤗',
];
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
 * Sends a reaction change and waits for its reply or error.
 *
 * @param client Reacting member.
 * @param id Message id.
 * @param emoji Emoji.
 * @param on True to add, false to remove.
 * @returns Reply or error.
 */
function react(client: TestClient, id: number, emoji: string, on: boolean = true): Promise<TestMessage> {
  return client.request({ t: 'chat.react', id, emoji, on }, 'chat.reaction');
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

/** Moves the relay clock past the reaction rate window. */
function windowPass(): void {
  setSystemTime(new Date(Date.now() + CHAT_REACTION_WINDOW_MS));
}

describe('chat reactions', () => {
  test('the welcome offers chat.react when asked for', async () => {
    const client = await connect('Caps');
    expect(client.welcome.caps).toContain('chat.react');
  });

  test('a reaction goes to capable members after its message, and only once per change', async () => {
    const [owner, bob, old] = (await roomWith(['Bob'], ['Old', ['select']])) as [TestClient, TestClient, TestClient];
    const id = await chatSend(owner, 'nice stairs');
    expect(await react(bob, id, '👍')).toMatchObject({ t: 'chat.reaction', id, from: bob.user, emoji: '👍', on: true });
    expect(await react(bob, id, '👍')).toMatchObject({ t: 'chat.reaction', on: true });
    expect(await owner.next('chat.reaction')).toEqual({
      t: 'chat.reaction',
      id,
      from: bob.user,
      emoji: '👍',
      on: true,
    });
    expect((await react(bob, id, '👍', false)).on).toBe(false);
    expect(await owner.next('chat.reaction')).toMatchObject({ on: false });
    await Bun.sleep(50);
    expect(owner.has('chat.reaction')).toBe(false);
    expect(await old.next('chat')).toMatchObject({ id });
    expect(old.has('chat.reaction')).toBe(false);
  });

  test('only single emoji are accepted', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    const id = await chatSend(owner, 'text');
    for (const emoji of ['a', '👍👍', '👍 ', '<b>', '\u200D👍', '1']) {
      expect(await react(owner, id, emoji)).toMatchObject({ code: 'chat_react_refused', reason: 'invalid_emoji' });
      windowPass();
    }
    expect((await react(owner, id, '🇩🇪')).t).toBe('chat.reaction');
  });

  test('unknown and old messages are refused', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    expect(await react(owner, 99, '👍')).toMatchObject({ code: 'chat_react_refused', reason: 'not_found' });
    const id = await chatSend(owner, 'soon old');
    setSystemTime(new Date(Date.now() + CHAT_REACTION_AGE_MAXIMUM_MS + 1000));
    expect(await react(owner, id, '👍')).toMatchObject({ code: 'chat_react_refused', reason: 'expired' });
  });

  test('reactions are capped per member and per message', async () => {
    const [owner, bob, cat] = (await roomWith(['Bob'], ['Cat'])) as [TestClient, TestClient, TestClient];
    const id = await chatSend(owner, 'popular');
    for (let index = 0; index < CHAT_REACTIONS_PER_MEMBER_MAXIMUM; index++) {
      if (index > 0 && index % CHAT_REACTIONS_PER_WINDOW === 0) windowPass();
      expect((await react(owner, id, EMOJI[index] ?? '')).t).toBe('chat.reaction');
    }
    windowPass();
    expect(await react(owner, id, '🐱')).toMatchObject({ code: 'chat_react_refused', reason: 'too_many' });
    for (let index = 0; index < CHAT_REACTION_EMOJIS_PER_MESSAGE_MAXIMUM - CHAT_REACTIONS_PER_MEMBER_MAXIMUM; index++) {
      if (index % (CHAT_REACTIONS_PER_WINDOW - 1) === 0) windowPass();
      expect((await react(bob, id, EMOJI[CHAT_REACTIONS_PER_MEMBER_MAXIMUM + index] ?? '')).t).toBe('chat.reaction');
    }
    windowPass();
    expect(await react(cat, id, '🐶')).toMatchObject({ code: 'chat_react_refused', reason: 'too_many' });
    expect((await react(cat, id, EMOJI[0] ?? '')).t).toBe('chat.reaction');
  });

  test('reaction changes are rate limited', async () => {
    const [owner] = (await roomWith(['Bob'])) as [TestClient];
    const id = await chatSend(owner, 'spam');
    for (let index = 0; index < CHAT_REACTIONS_PER_WINDOW; index++)
      expect((await react(owner, id, '👍', index % 2 === 0)).t).toBe('chat.reaction');
    const limited = await react(owner, id, '👍');
    expect(limited).toMatchObject({ code: 'chat_rate_limited' });
    expect(Number(limited.retryAfterMs)).toBeGreaterThan(0);
    windowPass();
    expect((await react(owner, id, '👍')).t).toBe('chat.reaction');
  });

  test('a connection without chat.react cannot react', async () => {
    const [owner, old] = (await roomWith(['Old', ['select']])) as [TestClient, TestClient];
    const id = await chatSend(owner, 'hello');
    expect(await react(old, id, '👍')).toMatchObject({ code: 'chat_react_refused', reason: 'unsupported' });
  });

  test('outside a room and malformed reactions are refused', async () => {
    const client = await connect('Alone');
    expect(await react(client, 1, '👍')).toMatchObject({ code: 'not_in_room' });
    client.send({ t: 'chat.react', id: 1, emoji: '👍', on: 'yes' });
    expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
  });

  test('an overlong emoji closes the connection', async () => {
    const client = await connect('Long');
    client.send({ t: 'chat.react', id: 1, emoji: '👍'.repeat(20), on: true });
    expect(await client.closed()).toBe(CLOSE_CODES.protocolViolation);
  });
});
