/**
 * Exact sliding-window boundaries, rather than bursty token-bucket
 * approximations.
 */
import { expect, test } from 'bun:test';
import { CustomWindow } from '../../../src/forks/custom_window.ts';
const LIMIT = 256 * 1024;

test('hundreds of small frames fit, exact byte boundary fits, one more byte fails', () => {
  const window = new CustomWindow();
  for (let i = 0; i < 1024; i++) expect(window.take(256, LIMIT, 4096, 0)).toBe(true);
  expect(window.take(1, LIMIT, 4096, 999.999)).toBe(false);
  expect(window.take(LIMIT, LIMIT, 4096, 1000)).toBe(true);
});

test('a sliding window cannot double its budget across a fixed-second boundary', () => {
  const window = new CustomWindow();
  expect(window.take(LIMIT / 2, LIMIT, 4096, 900)).toBe(true);
  expect(window.take(LIMIT / 2, LIMIT, 4096, 1100)).toBe(true);
  expect(window.take(1, LIMIT, 4096, 1899)).toBe(false);
  expect(window.take(LIMIT / 2, LIMIT, 4096, 1900)).toBe(true);
  expect(window.take(1, LIMIT, 4096, 2099)).toBe(false);
  expect(window.take(LIMIT / 2, LIMIT, 4096, 2100)).toBe(true);
});

test('empty frames and tiny frames have bounded bookkeeping', () => {
  const window = new CustomWindow();
  for (let i = 0; i < 4096; i++) expect(window.take(0, LIMIT, 4096, 0)).toBe(true);
  expect(window.take(0, LIMIT, 4096, 999)).toBe(false);
  expect(window.take(0, LIMIT, 4096, 1000)).toBe(true);
});
