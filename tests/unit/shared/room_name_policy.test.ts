import { expect, test } from 'bun:test';
import {
  displayNameFallback,
  displayNameKey,
  displayNameNormalize,
  displayNameUnique,
  roomNameNormalize,
} from '../../../src/shared/room_name_policy.ts';

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

test('invisible, blank-looking and stacked-mark names are rejected', () => {
  const invisible = ['a\u200Bb', 'a\u00ADb', 'a\u2060b', 'a\u206Fb', '\u{E0041}x', 'a\uE000b', 'a\uD800b', 'a\u2028b'];
  const blank = ['\u3164', 'a\u115Fb', '\u2800\u2800', 'a\uFFA0', 'a\u034Fb'];
  const zalgo = ['a' + '\u0301\u0302\u0303\u0304\u0305'];
  for (const bad of [...invisible, ...blank, ...zalgo]) {
    expect(roomNameNormalize(bad)).toEqual({ ok: false, reason: 'invalid_characters' });
  }
});

test('emoji sequences, accents and unusual spaces stay valid and spaces collapse', () => {
  expect(roomNameNormalize('👨\u200D👩\u200D👧 ❤️ 👍🏽').ok).toBe(true);
  expect(roomNameNormalize('a\u0301\u0302\u0303\u0304').ok).toBe(true);
  expect(roomNameNormalize('My\u00A0\u3000  Level\u2003')).toEqual({ ok: true, name: 'My Level' });
  expect(displayNameNormalize('\u00A0\u2003')).toEqual({ ok: false, reason: 'empty' });
});

test('display name keys fold case and compatibility forms', () => {
  expect(displayNameKey('Henry')).toBe(displayNameKey('HENRY'));
  expect(displayNameKey('Henry')).toBe(displayNameKey('Ｈｅｎｒｙ'));
  expect(displayNameKey('Henry')).not.toBe(displayNameKey('Henri'));
});

/**
 * Builds the set of taken name keys.
 *
 * @param names Names already in the room.
 * @returns Their comparison keys.
 */
function taken(...names: string[]): Set<string> {
  return new Set(names.map(displayNameKey));
}

test('a taken display name gets the lowest free number', () => {
  expect(displayNameUnique('Henry', taken())).toBe('Henry');
  expect(displayNameUnique('Henry', taken('Bob'))).toBe('Henry');
  expect(displayNameUnique('Henry', taken('henry'))).toBe('Henry2');
  expect(displayNameUnique('Henry', taken('Henry', 'Henry2'))).toBe('Henry3');
  expect(displayNameUnique('Henry', taken('Henry', 'Henry3'))).toBe('Henry2');
  expect(displayNameUnique('Henry2', taken('Henry2'))).toBe('Henry22');
});

test('numbered display names stay within 12 characters', () => {
  const twelve = 'abcdefghijkl';
  const taken = new Set([twelve, 'abcdefghijk2'].map(displayNameKey));
  expect(displayNameUnique(twelve, taken)).toBe('abcdefghijk3');
  const many = new Set(
    [twelve, ...Array.from({ length: 9 }, (_, index) => `abcdefghijk${index + 1}`)].map(displayNameKey),
  );
  expect(displayNameUnique(twelve, many)).toBe('abcdefghij10');
  expect(displayNameUnique('ab cdefghijk', new Set([displayNameKey('ab cdefghijk')]))).toBe(
    'ab cdefghijk'.slice(0, 11) + '2',
  );
  expect(displayNameUnique('abcdefghij k', new Set([displayNameKey('abcdefghij k')]))).toBe('abcdefghij2');
  for (const name of [twelve, '🎮'.repeat(12), 'Henry']) {
    const result = displayNameUnique(name, new Set([displayNameKey(name)]));
    expect(displayNameNormalize(result)).toEqual({ ok: true, name: result });
  }
});
