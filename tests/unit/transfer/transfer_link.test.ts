/** Transfer link tokens and per-owner link bookkeeping with a fake clock. */
import { describe, expect, test } from 'bun:test';
import { TRANSFER_LINK_PATTERN } from '../../../src/shared/protocol_definitions.ts';
import { TransferLinkCodec } from '../../../src/transfer/transfer_link_codec.ts';
import { TransferOwner } from '../../../src/transfer/transfer_owner.ts';

const LIMITS = {
  intervalMs: 5000,
  lifetimeMs: 3_600_000,
  chunkBytes: 262144,
  sizeMaximum: 1,
  downloads: 4,
  timeoutMs: 1,
};

describe('transfer link codec', () => {
  test('tokens are 43 url-safe characters, unique and not UUIDs', () => {
    const codec = new TransferLinkCodec();
    const nonce = new Uint8Array(16);
    const tokens = new Set(Array.from({ length: 2000 }, (_, counter) => codec.encode(7, counter, nonce)));
    expect(tokens.size).toBe(2000);
    for (const token of tokens) expect(TRANSFER_LINK_PATTERN.test(token)).toBe(true);
    expect([...tokens].some((token) => /^[0-9a-f-]{36}$/.test(token))).toBe(false);
  });

  test('tokens verify only with their owner nonce and relay secret', () => {
    const codec = new TransferLinkCodec();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const token = codec.encode(42, 3, nonce);
    expect(codec.parts(token)).toEqual({ user: 42, counter: 3 });
    expect(codec.verify(token, nonce)).toBe(true);
    expect(codec.verify(token, new Uint8Array(16))).toBe(false);
    expect(new TransferLinkCodec().verify(token, nonce)).toBe(false);
    const flipped = token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21);
    expect(codec.verify(flipped, nonce)).toBe(false);
  });

  test('the MAC part has at least 192 bits of entropy', () => {
    const codec = new TransferLinkCodec();
    const nonce = new Uint8Array(16);
    const bits = new Set<string>();
    for (let counter = 0; counter < 256; counter += 1) bits.add(codec.encode(1, counter, nonce).slice(11));
    expect(bits.size).toBe(256);
    expect(codec.encode(1, 0, nonce).slice(11).length * 6).toBeGreaterThanOrEqual(192);
  });
});

describe('transfer owner', () => {
  test('allows one link per interval', () => {
    const owner = new TransferOwner(LIMITS, () => {});
    expect(owner.retryAfterMs(1000)).toBe(0);
    owner.linkCreate(1000);
    expect(owner.retryAfterMs(1000)).toBe(5000);
    expect(owner.retryAfterMs(5999)).toBe(1);
    expect(owner.retryAfterMs(6000)).toBe(0);
  });

  test('links expire after their lifetime and are pruned', () => {
    const owner = new TransferOwner(LIMITS, () => {});
    const first = owner.linkCreate(0);
    const second = owner.linkCreate(5000);
    expect(owner.linkAlive(first, 3_599_999)).toBe(true);
    expect(owner.linkAlive(first, 3_600_000)).toBe(false);
    expect(owner.linkAlive(second, 3_600_000)).toBe(true);
    const third = owner.linkCreate(3_600_000);
    expect(owner.linkCount()).toBe(2);
    expect(owner.linkAlive(second, 3_600_001)).toBe(true);
    expect(owner.linkAlive(third, 3_600_001)).toBe(true);
    expect(owner.linkAlive(third + 1, 3_600_001)).toBe(false);
  });

  test('live links are bounded by lifetime divided by interval', () => {
    const owner = new TransferOwner(LIMITS, () => {});
    for (let now = 0; now < 3 * LIMITS.lifetimeMs; now += LIMITS.intervalMs) owner.linkCreate(now);
    expect(owner.linkCount()).toBeLessThanOrEqual(LIMITS.lifetimeMs / LIMITS.intervalMs);
  });
});
