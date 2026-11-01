/**
 * End-to-end check through the public proxy: connect -> hello -> create room ->
 * list -> second client joins -> snapshot relay. Asserts the server reports the
 * connection as coming through the proxy (via=proxy), then checks presence
 * (member name and color, a camera pose relayed between the two clients) and
 * whether internal test rooms are allowed.
 *
 * Usage: bun scripts/verify_public.ts [wss://aiworlded.00labs.net/ws]
 *
 * Env: EXPECT_VIA=proxy|direct (default proxy),
 * EXPECT_INTERNAL_TEST=forbidden|allowed (default forbidden; the dev relay at
 * /wstest allows them).
 */
import { binaryFrameEncode } from '../src/shared/binary_frame.ts';
import { presenceFrameDecode, presenceFrameEncode } from '../src/shared/presence_frame.ts';
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../src/shared/protocol_definitions.ts';

const url = process.argv[2] ?? process.env['PUBLIC_WS_URL'] ?? 'wss://aiworlded.00labs.net/ws';
const origin = 'https://henry00is.github.io';
/**
 * Expected trust verdict; 'proxy' through the reverse proxy, 'direct' when testing a local
 * server.
 */
const expectedVia = process.env['EXPECT_VIA'] ?? 'proxy';
/** Expected answer to an internal test room request. */
const expectedInternalTest = process.env['EXPECT_INTERNAL_TEST'] ?? 'forbidden';

/** Minimal client with an inbox. */
interface VerifyClient {
  readonly send: (m: object) => void;
  readonly raw: (d: Uint8Array) => void;
  readonly next: (t: string) => Promise<any>;
  readonly close: () => void;
}

/**
 * Waits for the first inbox message of a type and removes it.
 *
 * @param inbox Received messages.
 * @param type Message type to wait for.
 * @returns The message.
 * @throws When the server sends an error or nothing arrives within 10 seconds.
 */
async function inboxNext(inbox: any[], type: string): Promise<any> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(10)) {
    const index = inbox.findIndex((message) => message.t === type || message.t === 'error');
    if (index >= 0) {
      const [message] = inbox.splice(index, 1);
      if (message.t === 'error') throw new Error(`server error: ${JSON.stringify(message)}`);
      return message;
    }
  }
  throw new Error(`timeout waiting for ${type}`);
}

/**
 * Opens a socket that appends every received message to an inbox.
 *
 * @param inbox Inbox to fill.
 * @returns The connected socket.
 */
async function socketOpen(inbox: any[]): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Origin: origin } } as any);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) =>
    inbox.push(
      typeof event.data === 'string' ? JSON.parse(event.data) : { t: '#binary', data: new Uint8Array(event.data) },
    ),
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
  });
  return socket;
}

/**
 * Connects a minimal client with an inbox.
 *
 * @returns The client.
 */
async function clientOpen(): Promise<VerifyClient> {
  const inbox: any[] = [];
  const socket = await socketOpen(inbox);
  return {
    send: (m) => socket.send(JSON.stringify(m)),
    raw: (d) => socket.send(d as Uint8Array<ArrayBuffer>),
    next: (type) => inboxNext(inbox, type),
    close: () => socket.close(),
  };
}

/**
 * Reads live list pushes until the room is reported removed, checking that no
 * push ever carries an internal test room.
 *
 * @param watcher Subscribed client.
 * @param roomId Room that must disappear.
 */
async function verifySubscriptionRemoval(watcher: VerifyClient, roomId: string): Promise<void> {
  for (;;) {
    const update = await watcher.next('room.list.update');
    if (update.rooms.some((room: { name: string }) => room.name === 'verify internal'))
      throw new Error('internal test room pushed to a proxied subscriber');
    if (update.removed.includes(roomId)) break;
  }
  console.log('live list: room.list.update reported the closed room');
}

const hello = { t: 'hello', protocol: PROTOCOL_ID, version: PROTOCOL_VERSION, client: 'verify-public/1' };
const owner = await clientOpen();
owner.send({ ...hello, name: 'verify-own' });
const welcome = await owner.next('welcome');
console.log(`welcome: user=${welcome.user} via=${welcome.via}`);
if (welcome.via !== expectedVia) throw new Error(`expected via=${expectedVia}, got via=${welcome.via}`);

owner.send({ t: 'room.create', r: 1, name: `verify ${new Date().toISOString()}`, private: false });
const created = await owner.next('room.created');
console.log(`created room ${created.room.id}`);

const joiner = await clientOpen();
joiner.send({ ...hello, name: 'verify-join' });
await joiner.next('welcome');
joiner.send({ t: 'room.list', r: 2 });
const list = await joiner.next('room.list');
if (!list.rooms.some((room: { id: string }) => room.id === created.room.id)) throw new Error('room missing from list');
console.log(`list: ${list.rooms.length} room(s), ours present`);
if (list.rooms.find((room: { id: string }) => room.id === created.room.id)?.owner !== 'verify-own')
  throw new Error('room list entry does not name the owner');

const watcher = await clientOpen();
watcher.send({ ...hello, name: 'verify-watch' });
await watcher.next('welcome');
watcher.send({ t: 'room.subscribe', r: 5 });
const subscribed = await watcher.next('room.subscribed');
if (!subscribed.rooms.some((room: { id: string }) => room.id === created.room.id))
  throw new Error('room missing from room.subscribed');
console.log(`subscribed: ${subscribed.rooms.length} room(s), push interval ${subscribed.intervalMs} ms`);

joiner.send({ t: 'room.join', r: 3, room: created.room.id, discardLocalWork: true });
await joiner.next('room.joined');
const request = await owner.next('snapshot.request');
const snapshot = new TextEncoder().encode('{"verify":true}');
owner.send({ t: 'stream.begin', to: request.for, stream: 1, kind: 'snapshot', size: snapshot.length });
owner.raw(binaryFrameEncode(1, request.for, snapshot));
owner.send({ t: 'stream.end', to: request.for, stream: 1 });
await joiner.next('stream.begin');
await joiner.next('#binary');
await joiner.next('stream.end');
console.log('join + snapshot relay ok');

const memberJoined = await owner.next('member.joined');
if (memberJoined.name !== 'verify-join' || typeof memberJoined.color !== 'number')
  throw new Error(`unexpected member.joined: ${JSON.stringify(memberJoined)}`);
joiner.raw(presenceFrameEncode([{ id: 0, position: [1.5, 2, -3], quaternion: [0, 0, 0, 1], fov: 60 }]));
const presence = presenceFrameDecode((await owner.next('#binary')).data);
if (!presence || presence.sender !== memberJoined.user || presence.entries[0]?.position[0] !== 1.5)
  throw new Error(`unexpected presence frame: ${JSON.stringify(presence)}`);
console.log(`presence ok: member ${memberJoined.name} color ${memberJoined.color}, camera pose relayed`);

const tester = await clientOpen();
tester.send({ ...hello, name: 'verify-test' });
await tester.next('welcome');
tester.send({ t: 'room.create', r: 4, name: 'verify internal', private: false, internalTest: true });
const internalAnswer = await tester.next('room.created').then(
  () => 'allowed',
  (error: Error) => (String(error.message).includes('internal_test_forbidden') ? 'forbidden' : String(error)),
);
tester.close();
console.log(`internal test room: ${internalAnswer}`);
if (internalAnswer !== expectedInternalTest)
  throw new Error(`expected internal test rooms ${expectedInternalTest}, got ${internalAnswer}`);

owner.close();
const closed = await joiner.next('room.closed');
console.log(`owner disconnect -> room.closed offline=${closed.offline}`);
joiner.close();
await verifySubscriptionRemoval(watcher, created.room.id);
watcher.close();
console.log('PUBLIC VERIFICATION PASSED');
process.exit(0);
