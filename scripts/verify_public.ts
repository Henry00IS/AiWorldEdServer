/**
 * End-to-end check through the public proxy: connect -> hello -> create room ->
 * list -> second client joins -> snapshot relay. Asserts the server reports the
 * connection as coming through the proxy (via=proxy).
 *
 * Usage: bun scripts/verify_public.ts [wss://aiworlded.00labs.net/ws]
 */
import { binaryFrameEncode } from '../src/shared/binary_frame.ts';
import { PROTOCOL_ID, PROTOCOL_VERSION } from '../src/shared/protocol_definitions.ts';

const url = process.argv[2] ?? process.env.PUBLIC_WS_URL ?? 'wss://aiworlded.00labs.net/ws';
const origin = 'https://henry00is.github.io';
/**
 * Expected trust verdict; 'proxy' through the reverse proxy, 'direct' when testing a local
 * server.
 */
const expectedVia = process.env.EXPECT_VIA ?? 'proxy';

/** Minimal client with an inbox. */
async function clientOpen(): Promise<{
  send: (m: object) => void;
  raw: (d: Uint8Array) => void;
  next: (t: string) => Promise<any>;
  close: () => void;
}> {
  const socket = new WebSocket(url, { headers: { Origin: origin } } as any);
  socket.binaryType = 'arraybuffer';
  const inbox: any[] = [];
  socket.addEventListener('message', (event) =>
    inbox.push(typeof event.data === 'string' ? JSON.parse(event.data) : { t: '#binary' }),
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
  });
  const next = async (type: string) => {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(10)) {
      const index = inbox.findIndex((message) => message.t === type || message.t === 'error');
      if (index >= 0) {
        const [message] = inbox.splice(index, 1);
        if (message.t === 'error') throw new Error(`server error: ${JSON.stringify(message)}`);
        return message;
      }
    }
    throw new Error(`timeout waiting for ${type}`);
  };
  return { send: (m) => socket.send(JSON.stringify(m)), raw: (d) => socket.send(d), next, close: () => socket.close() };
}

const hello = { t: 'hello', protocol: PROTOCOL_ID, version: PROTOCOL_VERSION, client: 'verify-public/1' };
const owner = await clientOpen();
owner.send({ ...hello, name: 'verify-owner' });
const welcome = await owner.next('welcome');
console.log(`welcome: user=${welcome.user} via=${welcome.via}`);
if (welcome.via !== expectedVia) throw new Error(`expected via=${expectedVia}, got via=${welcome.via}`);

owner.send({ t: 'room.create', r: 1, name: `verify ${new Date().toISOString()}`, private: false });
const created = await owner.next('room.created');
console.log(`created room ${created.room.id}`);

const joiner = await clientOpen();
joiner.send({ ...hello, name: 'verify-joiner' });
await joiner.next('welcome');
joiner.send({ t: 'room.list', r: 2 });
const list = await joiner.next('room.list');
if (!list.rooms.some((room: { id: string }) => room.id === created.room.id)) throw new Error('room missing from list');
console.log(`list: ${list.rooms.length} room(s), ours present`);

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

owner.close();
const closed = await joiner.next('room.closed');
console.log(`owner disconnect -> room.closed offline=${closed.offline}`);
joiner.close();
console.log('PUBLIC VERIFICATION PASSED');
process.exit(0);
