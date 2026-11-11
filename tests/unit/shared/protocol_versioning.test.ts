/**
 * Unit tests of version negotiation, capability agreement and the user-facing
 * messages.
 */
import { expect, test } from 'bun:test';
import {
  protocolCapabilitiesAgree,
  protocolMismatchMessage,
  protocolNegotiate,
  protocolUnsupportedMessage,
} from '../../../src/shared/protocol_versioning.ts';

test('negotiation picks the newest version both sides speak', () => {
  expect(protocolNegotiate({ min: 2, max: 4 }, { min: 1, max: 3 })).toEqual({ ok: true, version: 3 });
  expect(protocolNegotiate({ min: 2, max: 2 }, { min: 2, max: 2 })).toEqual({ ok: true, version: 2 });
});

test('negotiation fails without overlap in either direction', () => {
  expect(protocolNegotiate({ min: 1, max: 1 }, { min: 2, max: 3 })).toEqual({ ok: false });
  expect(protocolNegotiate({ min: 4, max: 5 }, { min: 2, max: 3 })).toEqual({ ok: false });
});

test('capabilities are intersected in relay order and unknown ones dropped', () => {
  expect(protocolCapabilitiesAgree(['zzz', 'select', 'select'])).toEqual(['select']);
  expect(protocolCapabilitiesAgree([])).toEqual([]);
  expect(protocolCapabilitiesAgree(['typing', 'select', 'stats'])).toEqual(['select', 'stats', 'typing']);
  expect(protocolCapabilitiesAgree(['chat.react', 'typing'])).toEqual(['typing', 'chat.react']);
});

test('refusal messages tell who needs to update', () => {
  expect(protocolUnsupportedMessage({ min: 1, max: 1 }, { min: 2, max: 2 })).toEndWith('Update your editor.');
  expect(protocolUnsupportedMessage({ min: 5, max: 6 }, { min: 2, max: 3 })).toEndWith('This server needs an update.');
  expect(protocolMismatchMessage(1, 2)).toBe(
    'This room uses protocol v1; your editor speaks v2. Update or join a compatible room.',
  );
});
