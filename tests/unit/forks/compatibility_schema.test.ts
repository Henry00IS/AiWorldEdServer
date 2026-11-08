/** Strict closed identity and owner URL bounds at the wire boundary. */
import { expect, test } from 'bun:test';
import { protocolMessageDecode } from '../../../src/protocol/protocol_message_decoder.ts';
import { compatibilityHomeUrl } from '../../../src/shared/compatibility_identity.ts';

const join = {
  t: 'room.join',
  room: 'AbCdEfGhIjKlMn_-',
  discardLocalWork: true,
  compatibility: { version: '1', homeUrl: 'https://editor.invalid/' },
};

test('joiners send bounded URL/version, rejecting removed capabilities and schema', () => {
  expect(protocolMessageDecode(JSON.stringify(join)).ok).toBe(true);
  expect(
    protocolMessageDecode(
      JSON.stringify({ ...join, compatibility: { ...join.compatibility, homeUrl: 'x'.repeat(256) } }),
    ).ok,
  ).toBe(true);
  for (const change of [{ homeUrl: 'x'.repeat(257) }, { schema: 1 }, { caps: [] }, { version: 'x'.repeat(65) }]) {
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
    reason: 'incompatible_client',
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
