/** Strict closed identity and owner URL bounds at the wire boundary. */
import { expect, test } from 'bun:test';
import { protocolMessageDecode } from '../../../src/protocol/protocol_message_decoder.ts';
import { compatibilityHomeUrl } from '../../../src/shared/compatibility_identity.ts';

const join = {
  t: 'room.join',
  room: 'AbCdEfGhIjKlMn_-',
  discardLocalWork: true,
  compatibility: { version: '1', schema: 3, caps: ['scene'] },
};

test('joiners send version/schema/caps without any URL and all bounds are strict', () => {
  expect(protocolMessageDecode(JSON.stringify(join)).ok).toBe(true);
  for (const change of [
    { homeUrl: 'https://joiner.invalid' },
    { schema: -1 },
    { schema: 1.5 },
    { version: 'x'.repeat(65) },
    { caps: Array(33).fill('scene') },
    { caps: ['x'.repeat(65)] },
    { caps: [1] },
  ]) {
    expect(
      protocolMessageDecode(JSON.stringify({ ...join, compatibility: { ...join.compatibility, ...change } })).ok,
    ).toBe(false);
  }
});

test('owner verdicts have bounded public reasons and URL length', () => {
  const verdict = {
    t: 'compatibility.result',
    q: 1,
    allow: false,
    reason: 'missing_caps',
    homeUrl: 'https://owner.invalid/',
  };
  expect(protocolMessageDecode(JSON.stringify(verdict)).ok).toBe(true);
  expect(protocolMessageDecode(JSON.stringify({ ...verdict, reason: 'https://private.invalid' })).ok).toBe(false);
  expect(protocolMessageDecode(JSON.stringify({ ...verdict, homeUrl: 'x'.repeat(257) })).ok).toBe(false);
});

test('untrusted home URLs permit only bounded non-credential HTTP(S)', () => {
  expect(compatibilityHomeUrl('https://owner.invalid/editor')).toBe('https://owner.invalid/editor');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//owner.invalid',
    '<img src=x onerror=alert(1)>',
    'https://%',
    'https://user:pass@owner.invalid',
    'x'.repeat(257),
  ])
    expect(compatibilityHomeUrl(value)).toBeNull();
});
