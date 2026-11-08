/** Crawler card URLs: https behind a TLS proxy, and the curve preview image. */
import { describe, expect, test } from 'bun:test';
import { transferHttpPublicUrl, transferHttpThumbnailUrl } from '../../../src/server/server_transfer_http.ts';

const LINK_URL = 'http://relay.test/ws/transfer/abc';

describe('transfer card URLs', () => {
  test('a trusted proxy that terminated TLS makes the card URLs https', () => {
    const proxied = new Request(LINK_URL, { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(transferHttpPublicUrl(proxied, true).href).toBe('https://relay.test/ws/transfer/abc');
    expect(transferHttpPublicUrl(proxied, false).href).toBe(LINK_URL);
    expect(transferHttpPublicUrl(new Request(LINK_URL), true).href).toBe(LINK_URL);
  });

  test('only curve files get a ?thumbnail preview image', () => {
    const url = new URL(`${LINK_URL}?raw=1`);
    expect(transferHttpThumbnailUrl(url, 'Ramp.CURVE')).toBe(`${LINK_URL}?thumbnail`);
    expect(transferHttpThumbnailUrl(url, 'ramp.curve.txt')).toBeNull();
    expect(transferHttpThumbnailUrl(url, 'clip.mp4')).toBeNull();
  });
});
