import { expect, test } from 'bun:test';
import { displayNameFallback, displayNameNormalize, roomNameNormalize } from '../../../src/shared/room_name_policy.ts';

test('room names are trimmed, NFC-normalized and limited to 128 characters', () => {
  expect(roomNameNormalize('  My Level  ')).toEqual({ ok: true, name: 'My Level' });
  expect(roomNameNormalize('Cafe\u0301')).toEqual({ ok: true, name: 'Café' });
  expect(roomNameNormalize('x'.repeat(128)).ok).toBe(true);
  expect(roomNameNormalize('x'.repeat(129))).toEqual({ ok: false, reason: 'too_long' });
  expect(roomNameNormalize('🎮'.repeat(128)).ok).toBe(true);
  expect(roomNameNormalize('   ')).toEqual({ ok: false, reason: 'empty' });
});

test('control and bidi characters are rejected', () => {
  for (const bad of ['a\u0000b', 'a\nb', 'a\u202Eb', '\uFEFFroom', 'a\u0085b']) {
    expect(roomNameNormalize(bad)).toEqual({ ok: false, reason: 'invalid_characters' });
  }
});

test('display names are limited to 32 characters', () => {
  expect(displayNameNormalize('Henry').ok).toBe(true);
  expect(displayNameNormalize('n'.repeat(33))).toEqual({ ok: false, reason: 'too_long' });
});

test('display names are at most 12 characters and the fallback always fits', () => {
  expect(displayNameNormalize('abcdefghijkl')).toEqual({ ok: true, name: 'abcdefghijkl' });
  expect(displayNameNormalize('abcdefghijklm')).toEqual({ ok: false, reason: 'too_long' });
  expect(displayNameNormalize('ab\u0007c').ok).toBe(false);
  for (const user of [1, 42, 9_999_999, 10_000_000, 0xffffffff]) {
    const fallback = displayNameFallback(user);
    expect(displayNameNormalize(fallback)).toEqual({ ok: true, name: fallback });
  }
});
