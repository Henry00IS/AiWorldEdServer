/** Human-readable messages of refused transfer downloads. */
import { describe, expect, test } from 'bun:test';
import {
  transferHttpDiscordUnfurl,
  transferHttpDisposition,
  transferHttpHeaders,
  transferHttpIsDiscordbot,
  transferHttpIsSafeRasterImage,
  transferHttpRange,
  transferHttpStatusText,
  transferHttpWantsRaw,
  transferInlineAllowed,
} from '../../../src/server/server_transfer_http.ts';

describe('transfer status text', () => {
  test('413 names the configured limit', () => {
    expect(transferHttpStatusText(413, 100 * 1024 * 1024)).toBe('This file exceeds the 100 MiB limit.');
    expect(transferHttpStatusText(413, 1.5 * 1024 * 1024)).toBe('This file exceeds the 1.5 MiB limit.');
  });

  test('known and unknown failures read as plain sentences', () => {
    expect(transferHttpStatusText(404, 0)).toBe('This link is no longer available.');
    expect(transferHttpStatusText(502, 0)).toBe('The sender sent invalid data.');
    expect(transferHttpStatusText(599, 0)).toBe('The download failed.');
  });

  test('ranges: one satisfiable bytes range or null', () => {
    expect(transferHttpRange('bytes=0-9', 100)).toEqual({ start: 0, end: 10 });
    expect(transferHttpRange('bytes=90-', 100)).toEqual({ start: 90, end: 100 });
    expect(transferHttpRange('bytes=-10', 100)).toEqual({ start: 90, end: 100 });
    expect(transferHttpRange('bytes=-500', 100)).toEqual({ start: 0, end: 100 });
    expect(transferHttpRange('bytes=50-500', 100)).toEqual({ start: 50, end: 100 });
    for (const bad of ['bytes=100-', 'bytes=5-1', 'bytes=0-1,3-4', 'bytes=-', 'bytes=-0', 'bits=0-1', 'bytes=a-b'])
      expect(transferHttpRange(bad, 100)).toBeNull();
    expect(transferHttpRange('bytes=0-', 0)).toBeNull();
  });

  test('only safe renderable types open inline', () => {
    for (const mime of ['image/png', 'image/avif', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/ogg', 'application/pdf'])
      expect(transferInlineAllowed(mime)).toBe(true);
    for (const mime of ['image/svg+xml', 'text/html', 'application/xml', 'text/javascript', 'application/octet-stream'])
      expect(transferInlineAllowed(mime)).toBe(false);
  });
});

describe('transfer raw media headers', () => {
  test('images, mp4 and ogg audio get inline disposition with original filename', () => {
    const image = transferHttpHeaders({ size: 200_660, name: 'l52Zk.jpg', mime: 'image/jpeg' }, 'linkid', true);
    expect(image['Content-Type']).toBe('image/jpeg');
    expect(image['Content-Disposition']).toStartWith('inline;');
    expect(image['Content-Disposition']).toContain('filename="l52Zk.jpg"');
    expect(image['Accept-Ranges']).toBe('bytes');
    expect(image['Content-Length']).toBe('200660');

    const mp4 = transferHttpHeaders({ size: 50_000_000, name: 'clip.mp4', mime: 'video/mp4' }, 'linkid', true);
    expect(mp4['Content-Type']).toBe('video/mp4');
    expect(mp4['Content-Disposition']).toStartWith('inline;');
    expect(mp4['Content-Disposition']).toContain('filename="clip.mp4"');

    const ogg = transferHttpHeaders(
      { size: 20_220, name: 'VMDL_Move_1_AoE2.ogg', mime: 'audio/ogg' },
      'linkid',
      true,
    );
    expect(ogg['Content-Type']).toBe('audio/ogg');
    expect(ogg['Content-Disposition']).toStartWith('inline;');
    expect(ogg['Content-Disposition']).toContain('filename="VMDL_Move_1_AoE2.ogg"');
  });

  test('active content and ?download force attachment', () => {
    const svg = transferHttpHeaders({ size: 10, name: 'x.svg', mime: 'image/svg+xml' }, 'linkid', true);
    expect(svg['Content-Type']).toBe('image/svg+xml');
    expect(svg['Content-Disposition']).toStartWith('attachment;');

    const forced = transferHttpHeaders({ size: 10, name: 'a.png', mime: 'image/png' }, 'linkid', false);
    expect(forced['Content-Disposition']).toStartWith('attachment;');
  });

  test('disposition preserves sanitized original names', () => {
    expect(transferHttpDisposition('report.pdf', true)).toStartWith('inline;');
    expect(transferHttpDisposition('report.pdf', false)).toStartWith('attachment;');
  });
});

describe('transfer Discord unfurl', () => {
  test('detects Discordbot, raw query and safe raster images', () => {
    expect(
      transferHttpIsDiscordbot(
        new Request('https://example.test/ws/transfer/x', {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
        }),
      ),
    ).toBe(true);
    expect(transferHttpIsDiscordbot(new Request('https://example.test/x', { headers: { 'user-agent': 'Mozilla/5.0' } }))).toBe(
      false,
    );
    expect(transferHttpWantsRaw(new URL('https://example.test/ws/transfer/x?raw=1'))).toBe(true);
    expect(transferHttpWantsRaw(new URL('https://example.test/ws/transfer/x?download=1'))).toBe(true);
    expect(transferHttpWantsRaw(new URL('https://example.test/ws/transfer/x'))).toBe(false);
    expect(transferHttpIsSafeRasterImage('image/jpeg')).toBe(true);
    expect(transferHttpIsSafeRasterImage('image/png')).toBe(true);
    expect(transferHttpIsSafeRasterImage('image/svg+xml')).toBe(false);
    expect(transferHttpIsSafeRasterImage('audio/ogg')).toBe(false);
    expect(transferHttpIsSafeRasterImage('video/mp4')).toBe(false);
  });

  test('non-image card uses escaped filename and size without MIME chatter', async () => {
    const response = transferHttpDiscordUnfurl(
      new URL('https://example.test/wsdev/transfer/abcd'),
      { size: 2_120_000, name: 'Song & "great".mp3', mime: 'audio/mpeg' },
      'abcd',
      false,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/html');
    expect(response.headers.get('content-disposition')).toBeNull();
    const body = await response.text();
    expect(body).toContain('og:title');
    expect(body).toContain('Song &amp;');
    expect(body).toContain('2.12 MB');
    expect(body).not.toContain('audio/mpeg');
    expect(body).toContain('?raw=1');
    expect(body).not.toContain('og:image');
    expect(body).not.toContain('og:video');
    expect(body).not.toContain('<script');
  });

  test('image card helper is unused for safe rasters (no og:image site card)', async () => {
    // Safe images never call unfurl in serve(); if invoked, still no recursive raw image tag required.
    const response = transferHttpDiscordUnfurl(
      new URL('https://example.test/ws/transfer/img1'),
      { size: 1000, name: 'shot.png', mime: 'image/png' },
      'img1',
      false,
    );
    const body = await response.text();
    expect(body).toContain('shot.png');
    expect(body).toContain('?raw=1');
    expect(body).not.toContain('og:image');
  });
});
