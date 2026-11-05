/** Human-readable messages of refused transfer downloads. */
import { describe, expect, test } from 'bun:test';
import {
  transferHttpDiscordUnfurl,
  transferHttpIsDiscordbot,
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
    for (const mime of ['image/png', 'image/avif', 'video/webm', 'audio/mpeg', 'application/pdf'])
      expect(transferInlineAllowed(mime)).toBe(true);
    for (const mime of ['image/svg+xml', 'text/html', 'application/xml', 'text/javascript', 'application/octet-stream'])
      expect(transferInlineAllowed(mime)).toBe(false);
  });
});

describe('transfer Discord unfurl', () => {
  test('detects Discordbot and raw query', () => {
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
  });

  test('builds an HTML Open Graph card with escaped metadata and raw link', async () => {
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
    expect(body).toContain('audio/mpeg');
    expect(body).toContain('?raw=1');
    expect(body).not.toContain('og:video');
    expect(body).not.toContain('<script');
  });

  test('image unfurls point og:image at the raw media URL', async () => {
    const response = transferHttpDiscordUnfurl(
      new URL('https://example.test/ws/transfer/img1'),
      { size: 1000, name: 'shot.png', mime: 'image/png' },
      'img1',
      false,
    );
    const body = await response.text();
    expect(body).toContain('og:image');
    expect(body).toContain('https://example.test/ws/transfer/img1?raw=1');
    expect(body).toContain('image/png');
  });
});
