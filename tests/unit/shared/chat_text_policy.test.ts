import { describe, expect, test } from 'bun:test';
import {
  CHAT_TEXT_LENGTH_MAXIMUM,
  CHAT_TEXT_LINES_MAXIMUM,
  CHAT_TEXT_WIRE_MAXIMUM,
  chatTextClean,
  chatTextLength,
  chatTextLines,
  chatTextNormalize,
  chatReactionEmojiIs,
} from '../../../src/shared/chat_text_policy.ts';

/**
 * Builds a text of numbered lines.
 *
 * @param count Number of lines.
 * @returns Lines joined with line feeds.
 */
function linesOf(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
}

describe('chat text normalization', () => {
  test('keeps ordinary text, emoji sequences and keycaps unchanged', () => {
    for (const text of ['Hello there!', 'Ça va? 日本語 مرحبا', '👨\u200D👩\u200D👧 family', '1\uFE0F\u20E3', '👍🏽']) {
      expect(chatTextNormalize(text)).toEqual({ ok: true, text });
    }
  });

  test('composes to NFC and unifies line breaks', () => {
    expect(chatTextClean('Cafe\u0301')).toBe('Café');
    expect(chatTextClean('a\r\nb\rc\u2028d\u2029e\u0085f')).toBe('a\nb\nc\nd\ne\nf');
  });

  test('removes control, bidi, zero width, tag and private-use characters', () => {
    expect(chatTextClean('a\u0000b\u0007c\u001Bd\u007Fe')).toBe('abcde');
    expect(chatTextClean('user\u202Egnp.exe')).toBe('usergnp.exe');
    expect(chatTextClean('\u2066x\u2069\u200E\u200F\u061C')).toBe('x');
    expect(chatTextClean('ad\u200Bmin\u200C\u2060\uFEFF')).toBe('admin');
    expect(chatTextClean('tag\u{E0041}\u{E007F} \uE000\u{F0000}')).toBe('tag');
    expect(chatTextClean('\u2800\u3164\u115F')).toBe('');
  });

  test('keeps a zero width joiner only between emoji', () => {
    expect(chatTextClean('a\u200Db')).toBe('ab');
    expect(chatTextClean('\u200D👍')).toBe('👍');
    expect(chatTextClean('👍\u200D')).toBe('👍');
    expect(chatTextClean('🏳\uFE0F\u200D🌈')).toBe('🏳\uFE0F\u200D🌈');
  });

  test('caps stacked combining marks at four', () => {
    expect(chatTextClean(`a${'\u0336'.repeat(30)}`)).toBe(`a${'\u0336'.repeat(4)}`);
  });

  test('tidies whitespace without touching inner spacing', () => {
    expect(chatTextClean('\t  hi\tthere  \n\n\n\n\nbye   ')).toBe('hi there\n\nbye');
    expect(chatTextClean('a  b')).toBe('a  b');
  });

  test('rejects empty and invisible-only messages', () => {
    for (const text of ['', '   ', '\n\n', '\u200B\u202E', '\u0000']) {
      expect(chatTextNormalize(text)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  test('counts code points, not UTF-16 units, against the 2000 limit', () => {
    expect(chatTextNormalize('x'.repeat(CHAT_TEXT_LENGTH_MAXIMUM)).ok).toBe(true);
    expect(chatTextNormalize('😀'.repeat(CHAT_TEXT_LENGTH_MAXIMUM)).ok).toBe(true);
    expect(chatTextNormalize('x'.repeat(CHAT_TEXT_LENGTH_MAXIMUM + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(chatTextLength('😀a')).toBe(2);
    expect(CHAT_TEXT_WIRE_MAXIMUM).toBeGreaterThanOrEqual(CHAT_TEXT_LENGTH_MAXIMUM * 2);
  });

  test('allows up to 20 lines', () => {
    expect(chatTextNormalize(linesOf(CHAT_TEXT_LINES_MAXIMUM)).ok).toBe(true);
    expect(chatTextNormalize(linesOf(CHAT_TEXT_LINES_MAXIMUM + 1))).toEqual({ ok: false, reason: 'too_many_lines' });
    expect(chatTextLines('a')).toBe(1);
  });

  test('applies stricter limits when given', () => {
    expect(chatTextNormalize('hello', { length: 4, lines: 20 })).toEqual({ ok: false, reason: 'too_long' });
    expect(chatTextNormalize('a\nb', { length: 100, lines: 1 })).toEqual({ ok: false, reason: 'too_many_lines' });
  });

  test('leaves markup as inert text for the client to render as text', () => {
    const markup = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    expect(chatTextNormalize(markup)).toEqual({ ok: true, text: markup });
  });
});

describe('chatReactionEmojiIs', () => {
  test('accepts exactly one emoji, flags, keycaps, skin tones and joined sequences', () => {
    for (const emoji of ['👍', '❤️', '❤', '👍🏽', '👨‍👩‍👧', '🇩🇪', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) expect(chatReactionEmojiIs(emoji)).toBe(true);
  });

  test('refuses text, several emoji, spaces, lone joiners and overlong sequences', () => {
    for (const text of [
      '',
      'a',
      '1',
      '👍👍',
      '👍 ',
      '<b>',
      '\u200D👍',
      '👍\u200D',
      '👍\u202E',
      '👨‍'.repeat(12) + '👨',
    ])
      expect(chatReactionEmojiIs(text)).toBe(false);
  });

  test('refuses text that is not in normalized form', () => {
    expect(chatReactionEmojiIs('\u0041\u030A')).toBe(false);
  });
});
