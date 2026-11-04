/** Sanitizing of announced transfer file names and types. */
import { describe, expect, test } from 'bun:test';
import {
  transferMimeSanitize,
  transferNameAscii,
  transferNameSanitize,
} from '../../../src/shared/transfer_file_policy.ts';

const LINK = 'Tr4nsferL1nkTr4nsferL1nkTr4nsferL1nk_-AbCdE';

/**
 * Sanitizes with the test link as fallback.
 *
 * @param name Announced name.
 * @returns Served name.
 */
function clean(name: string): string {
  return transferNameSanitize(name, LINK);
}

describe('transfer file names', () => {
  test('drops NUL, control and bidi characters', () => {
    expect(clean('a\u0000b\u0007c\u001f\u007f\u0085.txt')).toBe('abc.txt');
    expect(clean('\u202Egnp.exe')).toBe('gnp.exe');
    expect(clean('line\r\nbreak.txt')).toBe('linebreak.txt');
  });

  test('keeps only the last path segment', () => {
    expect(clean('../../x')).toBe('x');
    expect(clean('..\\..\\windows\\evil.exe')).toBe('evil.exe');
    expect(clean('/etc/passwd/')).toBe('passwd');
  });

  test('drops Windows-invalid characters and trailing dots and spaces', () => {
    expect(clean('a<b>:c"d|e?f*.txt')).toBe('abcdef.txt');
    expect(clean('  name. . ')).toBe('name');
  });

  test('replaces reserved device names with the link id', () => {
    for (const name of ['CON', 'prn', 'Aux.txt', 'nul.tar.gz', 'COM1', 'lpt9.log', 'COM¹', 'con .txt']) {
      expect(clean(name).startsWith(LINK)).toBe(true);
    }
    expect(clean('con.txt')).toBe(`${LINK}.txt`);
    expect(clean('CONSOLE.txt')).toBe('CONSOLE.txt');
  });

  test('shortens long names to 255 characters and keeps the extension', () => {
    const shortened = clean(`${'x'.repeat(300)}.png`);
    expect(shortened.length).toBe(255);
    expect(shortened.endsWith('x.png')).toBe(true);
    const unicode = clean(`${'ü'.repeat(300)}.jpeg`);
    expect(Array.from(unicode).length).toBe(255);
    expect(clean(`a.${'b'.repeat(300)}`).length).toBe(255);
  });

  test('names without an extension and unicode names pass unchanged', () => {
    expect(clean('README')).toBe('README');
    expect(clean('Fotos – Ürlaub 🌴.jpg')).toBe('Fotos – Ürlaub 🌴.jpg');
    expect(clean('.gitignore')).toBe('.gitignore');
  });

  test('empty or broken names become the link id', () => {
    for (const name of ['', '   ', '...', '..', '/', '\u0000\u0001', '<>|']) expect(clean(name)).toBe(LINK);
  });

  test('the ASCII variant replaces other characters', () => {
    expect(transferNameAscii('Ürlaub 🌴.jpg')).toBe('_rlaub _.jpg');
  });
});

describe('transfer file types', () => {
  test('keeps plain types, lowercased and without parameters', () => {
    expect(transferMimeSanitize('image/png')).toBe('image/png');
    expect(transferMimeSanitize('Image/PNG; charset=x')).toBe('image/png');
    expect(transferMimeSanitize('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
  });

  test('anything else becomes application/octet-stream', () => {
    for (const mime of ['', 'png', 'a/b/c', 'text/html\r\nX-Evil: 1', 'text/ html', `a/${'b'.repeat(200)}`, 'ü/x']) {
      expect(transferMimeSanitize(mime)).toBe('application/octet-stream');
    }
  });
});
