import { expect, test } from 'bun:test';
import { ALLOWED_ORIGINS_DEFAULT } from '../../../src/config/server_configuration.ts';
import { originIsAllowed } from '../../../src/network/origin_policy.ts';

test('origin allow list', () => {
  expect(originIsAllowed('https://henry00is.github.io', ALLOWED_ORIGINS_DEFAULT)).toBe(true);
  expect(originIsAllowed('http://localhost:5173', ALLOWED_ORIGINS_DEFAULT)).toBe(true);
  expect(originIsAllowed('http://localhost.evil.com:5173', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed('https://evil.example', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed('null', ALLOWED_ORIGINS_DEFAULT)).toBe(false);
  expect(originIsAllowed(null, ALLOWED_ORIGINS_DEFAULT)).toBe(false);
});
