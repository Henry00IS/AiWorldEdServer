/**
 * Transfer links end to end: link creation and its rate limit, HTTP serving
 * with safe headers, on-demand chunk streaming with one chunk in flight per
 * owner, aborts, timeouts, disconnects and chat attachments.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import { roomCreate } from '../support/test_room.ts';
import { TestTransferEditor, type TestTransferFile } from '../support/test_transfer_editor.ts';

const CHUNK = 256 * 1024;
let server: CollabServer;
const editors: TestTransferEditor[] = [];

beforeAll(() => {
  server = collabServerStart(
    testConfiguration({
      connectionsPerIp: 200,
      chatIntervalMs: 50,
      transferCreateIntervalMs: 20,
      transferReplyTimeoutMs: 400,
    }),
  );
});

afterEach(async () => {
  for (const editor of editors.splice(0)) editor.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects a tracked test editor.
 *
 * @returns Editor.
 */
async function editorConnect(): Promise<TestTransferEditor> {
  const editor = await TestTransferEditor.connect(server.port);
  editors.push(editor);
  return editor;
}

/**
 * Builds a file of random bytes.
 *
 * @param size Byte count.
 * @param name File name.
 * @param mime Type.
 * @returns File.
 */
function fileOf(size: number, name = 'data.bin', mime = 'application/octet-stream'): TestTransferFile {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  return { bytes, name, mime };
}

/**
 * Returns the HTTP URL of a link.
 *
 * @param link Link id.
 * @returns URL.
 */
function urlOf(link: string): string {
  return `http://127.0.0.1:${server.port}/ws/transfer/${link}`;
}

/**
 * Hex SHA-256 of bytes.
 *
 * @param bytes Bytes.
 * @returns Digest.
 */
function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/**
 * Waits between link requests of one editor.
 *
 * @returns After the interval.
 */
function interval(): Promise<void> {
  return Bun.sleep(25);
}

describe('transfer links', () => {
  test('welcome advertises the transfer limits and capability', async () => {
    const client = await TestClient.connect(server.port, { caps: ['select', 'transfer'] });
    expect(client.welcome.caps).toContain('transfer');
    expect(client.welcome.limits).toMatchObject({ transferIntervalMs: 20, transferLifetimeMs: 3_600_000 });
    expect(client.welcome.limits.transferBytes).toBe(100 * 1024 * 1024);
    client.close();
  });

  test('link requests need the capability and are rate limited', async () => {
    const plain = await TestClient.connect(server.port);
    plain.send({ t: 'transfer.create' });
    expect(await plain.closed()).toBeGreaterThan(0);
    const editor = await editorConnect();
    const first = await editor.request({ t: 'transfer.create' });
    expect(first.t).toBe('transfer.created');
    expect(first.link).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.expiresInMs).toBe(3_600_000);
    const second = await editor.request({ t: 'transfer.create' });
    expect(second).toMatchObject({ t: 'error', code: 'transfer_rate_limited' });
    expect(second.retryAfterMs).toBeGreaterThan(0);
    await Bun.sleep(second.retryAfterMs + 5);
    expect((await editor.request({ t: 'transfer.create' })).t).toBe('transfer.created');
  });

  test('unknown, malformed and foreign paths answer 404; other methods 405', async () => {
    const unknown = await fetch(urlOf('A'.repeat(43)));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(urlOf('short'))).status).toBe(404);
    expect((await fetch(`${urlOf('A'.repeat(43))}.png`)).status).toBe(404);
    expect((await fetch(urlOf('A'.repeat(43)), { method: 'POST' })).status).toBe(405);
    expect((await fetch(urlOf('A'.repeat(43)), { method: 'OPTIONS' })).status).toBe(204);
  });

  test('a download carries the bytes and safe headers', async () => {
    const editor = await editorConnect();
    const file = fileOf(CHUNK * 2 + 123, 'Bericht – Ü 🌴.pdf', 'application/pdf');
    const link = await editor.share(file);
    const response = await fetch(urlOf(link));
    expect(response.status).toBe(200);
    const headers = Object.fromEntries(response.headers);
    expect(headers['content-type']).toBe('application/pdf');
    expect([String(file.bytes.length), undefined]).toContain(headers['content-length']);
    expect(headers['content-disposition']).toBe(
      `inline; filename="Bericht _ _ _.pdf"; filename*=UTF-8''${encodeURIComponent('Bericht – Ü 🌴.pdf')}`,
    );
    expect(headers['accept-ranges']).toBe('bytes');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(file.bytes));
  });

  test('announced names and types are sanitized; inline only for media', async () => {
    const editor = await editorConnect();
    const evil = await editor.share({ bytes: new Uint8Array([1]), name: '../../CON.txt', mime: 'text/html\r\nX: 1' });
    const head = await fetch(urlOf(evil), { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('1');
    expect(head.headers.get('content-type')).toBe('application/octet-stream');
    expect(head.headers.get('content-disposition')).toBe(
      `attachment; filename="${evil}.txt"; filename*=UTF-8''${evil}.txt`,
    );
    await interval();
    const image = await editor.share({ bytes: new Uint8Array([1, 2]), name: 'a.png', mime: 'image/png' });
    const inline = await fetch(urlOf(image), { method: 'HEAD' });
    expect(inline.headers.get('content-disposition')).toStartWith('inline;');
    expect(inline.headers.get('content-security-policy')).toEndWith('; sandbox');
    expect(inline.headers.get('content-length')).toBe('2');
    const forced = await fetch(`${urlOf(image)}?download`, { method: 'HEAD' });
    expect(forced.headers.get('content-disposition')).toStartWith('attachment;');
  });

  test('Discordbot gets raw images; non-image types get HTML cards; browsers stay raw', async () => {
    const editor = await editorConnect();
    const image = await editor.share({ bytes: new Uint8Array([1, 2, 3]), name: 'l52Zk.jpg', mime: 'image/jpeg' });
    await interval();
    const ogg = await editor.share({
      bytes: new Uint8Array(32),
      name: 'VMDL_Move_1_AoE2.ogg',
      mime: 'audio/ogg',
    });
    await interval();
    const mp4 = await editor.share({ bytes: new Uint8Array(64), name: 'clip.mp4', mime: 'video/mp4' });
    const discordUa = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

    const imageBrowser = await fetch(urlOf(image), { method: 'HEAD' });
    const imageBot = await fetch(urlOf(image), { method: 'HEAD', headers: { 'User-Agent': discordUa } });
    expect(imageBrowser.headers.get('content-type')).toBe('image/jpeg');
    expect(imageBot.headers.get('content-type')).toBe('image/jpeg');
    expect(imageBot.headers.get('content-disposition')).toBe(imageBrowser.headers.get('content-disposition'));
    expect(imageBot.headers.get('content-disposition')).toStartWith('inline;');
    expect(imageBot.headers.get('content-type')).not.toContain('text/html');
    const imageRange = await fetch(urlOf(image), {
      headers: { Range: 'bytes=0-1', 'User-Agent': discordUa },
    });
    expect(imageRange.status).toBe(206);
    expect(imageRange.headers.get('content-type')).toBe('image/jpeg');

    for (const [link, mime, name] of [
      [ogg, 'audio/ogg', 'VMDL_Move_1_AoE2.ogg'],
      [mp4, 'video/mp4', 'clip.mp4'],
    ] as const) {
      const browser = await fetch(urlOf(link), { method: 'HEAD' });
      expect(browser.status).toBe(200);
      expect(browser.headers.get('content-type')).toBe(mime);
      expect(browser.headers.get('content-disposition')).toStartWith('inline;');
      expect(browser.headers.get('content-disposition')).toContain(`filename="${name}"`);

      const bot = await fetch(urlOf(link), { headers: { 'User-Agent': discordUa } });
      expect(bot.status).toBe(200);
      expect(bot.headers.get('content-type')).toStartWith('text/html');
      const body = await bot.text();
      expect(body).toContain(name);
      expect(body).toContain('og:title');
      expect(body).toContain('?raw=1');
      expect(body).not.toContain(mime);

      const raw = await fetch(`${urlOf(link)}?raw=1`, { method: 'HEAD', headers: { 'User-Agent': discordUa } });
      expect(raw.headers.get('content-type')).toBe(mime);
      expect(raw.headers.get('content-disposition')).toStartWith('inline;');
      expect(raw.headers.get('accept-ranges')).toBe('bytes');
    }
  });

  test('active types such as SVG always download in a sandbox', async () => {
    const editor = await editorConnect();
    const svg = await editor.share({ bytes: new Uint8Array([1]), name: 'a.svg', mime: 'image/svg+xml' });
    const vector = await fetch(urlOf(svg), { method: 'HEAD' });
    expect(vector.headers.get('content-disposition')).toStartWith('attachment;');
    expect(vector.headers.get('content-security-policy')).toEndWith('; sandbox');
    expect(editor.chunkLog).toEqual([]);
  });

  test('a single byte range answers 206 with the exact bytes; invalid ranges 416', async () => {
    const editor = await editorConnect();
    const file = fileOf(CHUNK * 3 + 7, 'clip.mp4', 'video/mp4');
    const link = await editor.share(file);
    const size = file.bytes.length;
    const cases: [string, number, number][] = [
      [`bytes=${CHUNK + 5}-${CHUNK * 2 + 9}`, CHUNK + 5, CHUNK * 2 + 10],
      [`bytes=${size - 3}-`, size - 3, size],
      ['bytes=-100', size - 100, size],
      [`bytes=0-${size * 2}`, 0, size],
    ];
    for (const [range, start, end] of cases) {
      const response = await fetch(urlOf(link), { headers: { Range: range } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end - 1}/${size}`);
      expect(response.headers.get('content-disposition')).toStartWith('inline;');
      expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(file.bytes.subarray(start, end)));
    }
  });

  test('several, reversed, foreign or unsatisfiable ranges answer 416', async () => {
    const editor = await editorConnect();
    const link = await editor.share(fileOf(CHUNK + 7));
    const size = CHUNK + 7;
    for (const range of [`bytes=${size}-`, 'bytes=0-1,4-5', 'bytes=5-2', 'items=0-1', 'bytes=-0']) {
      const response = await fetch(urlOf(link), { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe(`bytes */${size}`);
      await response.arrayBuffer();
    }
    expect(editor.chunkLog).toEqual([]);
    expect(server.core.sessions.get(editor.user)?.transfer?.downloads.size ?? 0).toBe(0);
  });

  test('ranges opened and aborted in a row free the slot promptly', async () => {
    const editor = await editorConnect();
    const file = fileOf(CHUNK * 8);
    const link = await editor.share(file);
    for (let index = 0; index < 5; index++) {
      const abort = new AbortController();
      const response = await fetch(urlOf(link), {
        signal: abort.signal,
        headers: { Range: `bytes=${index * CHUNK}-` },
      });
      await response.body?.getReader().read();
      abort.abort();
    }
    const started = Date.now();
    const response = await fetch(urlOf(link), { headers: { Range: `bytes=${CHUNK * 6}-` } });
    expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(sha256(file.bytes.subarray(CHUNK * 6)));
    expect(Date.now() - started).toBeLessThan(300);
    expect(editor.maxOutstanding).toBe(1);
    await Bun.sleep(20);
    expect(server.core.sessions.get(editor.user)?.transfer?.downloads.size ?? 0).toBe(0);
  });

  test('files above 100 MiB answer 413, empty files 200', async () => {
    const editor = await editorConnect();
    const huge = await editor.share({
      bytes: new Uint8Array(),
      name: 'big.bin',
      mime: 'a/b',
      size: 100 * 1024 * 1024 + 1,
    });
    const refused = await fetch(urlOf(huge));
    expect(refused.status).toBe(413);
    expect(refused.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await refused.text()).toContain('This file exceeds the 100 MiB limit.');
    expect(editor.socket.readyState).toBe(WebSocket.OPEN);
    editor.files.delete(huge);
    expect((await fetch(urlOf(huge))).status).toBe(404);
    await interval();
    const empty = await editor.share({ bytes: new Uint8Array(), name: 'empty', mime: 'text/plain' });
    const response = await fetch(urlOf(empty));
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('a short or misplaced chunk fails only that download, the sender stays connected', async () => {
    const editor = await editorConnect();
    const short = await editor.share({ ...fileOf(CHUNK + 10), size: CHUNK * 2 });
    const failed = fetch(urlOf(short)).then((response) => response.arrayBuffer());
    await expect(failed).rejects.toThrow();
    await interval();
    const file = fileOf(CHUNK + 5);
    const good = await editor.share(file);
    const body = new Uint8Array(await (await fetch(urlOf(good))).arrayBuffer());
    expect(sha256(body)).toBe(sha256(file.bytes));
    editor.socket.send(new Uint8Array([0xa7, 3, 0]));
    await Bun.sleep(30);
    expect(editor.socket.readyState).toBe(WebSocket.OPEN);
  });

  test('five concurrent downloads interleave with one chunk in flight', async () => {
    const editor = await editorConnect();
    const files = Array.from({ length: 5 }, (_, index) => fileOf(CHUNK * 4 + index, `f${index}.bin`));
    const links: string[] = [];
    for (const file of files) {
      links.push(await editor.share(file));
      await interval();
    }
    const bodies = await Promise.all(
      links.map(async (link) => new Uint8Array(await (await fetch(urlOf(link))).arrayBuffer())),
    );
    bodies.forEach((body, index) => expect(sha256(body)).toBe(sha256(files[index]?.bytes ?? new Uint8Array())));
    expect(editor.maxOutstanding).toBe(1);
    expect(editor.chunkLog.length).toBe(24);
    const switches = editor.chunkLog.filter((q, index) => index > 0 && q !== editor.chunkLog[index - 1]).length;
    expect(switches).toBeGreaterThanOrEqual(12);
  });

  test('an aborted download frees the slot for the next one', async () => {
    const editor = await editorConnect();
    const file = fileOf(CHUNK * 8);
    const link = await editor.share(file);
    const abort = new AbortController();
    const response = await fetch(urlOf(link), { signal: abort.signal });
    await response.body?.getReader().read();
    abort.abort();
    await Bun.sleep(20);
    const started = Date.now();
    const body = new Uint8Array(await (await fetch(urlOf(link))).arrayBuffer());
    expect(sha256(body)).toBe(sha256(file.bytes));
    expect(Date.now() - started).toBeLessThan(300);
    expect(server.core.sessions.get(editor.user)?.transfer?.downloads.size ?? 0).toBe(0);
  });

  test('a silent owner times out the download', async () => {
    const editor = await editorConnect();
    const link = await editor.share(fileOf(CHUNK * 2));
    editor.answering = false;
    await expect(fetch(urlOf(link)).then((response) => response.arrayBuffer())).rejects.toThrow();
    editor.answering = true;
    const body = new Uint8Array(await (await fetch(urlOf(link))).arrayBuffer());
    expect(body.length).toBe(CHUNK * 2);
  });

  test('links die when the owner disconnects', async () => {
    const editor = await editorConnect();
    const link = await editor.share(fileOf(10));
    expect((await fetch(urlOf(link), { method: 'HEAD' })).status).toBe(200);
    editor.close();
    await Bun.sleep(50);
    expect((await fetch(urlOf(link))).status).toBe(404);
  });

  test('chat messages carry a sanitized attachment for the sender\u2019s own live link', async () => {
    const alice = await TestClient.connect(server.port, { caps: ['select', 'transfer'], name: 'Alice' });
    await roomCreate(alice);
    const created = await alice.request({ t: 'transfer.create' }, 'transfer.created');
    const file = { link: created.link, name: 'a/b<c>.png', size: 5, mime: 'IMAGE/PNG' };
    const sent = await alice.request({ t: 'chat', text: 'b.png', file }, 'chat.sent');
    expect(sent.file).toEqual({ link: created.link, name: 'bc.png', size: 5, mime: 'image/png' });
    const foreign = { ...file, link: 'A'.repeat(43) };
    await Bun.sleep(60);
    expect(await alice.request({ t: 'chat', text: 'x', file: foreign }, 'chat.sent')).toMatchObject({
      code: 'transfer_unavailable',
    });
    await Bun.sleep(60);
    const huge = { ...file, size: 101 * 1024 * 1024 };
    expect((await alice.request({ t: 'chat', text: 'big', file: huge }, 'chat.sent')).file.size).toBe(huge.size);
    alice.close();
  });
});
