/** Human-readable messages of refused transfer downloads. */
import { describe, expect, test } from 'bun:test';
import { transferHttpStatusText } from '../../../src/server/server_transfer_http.ts';

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
});
