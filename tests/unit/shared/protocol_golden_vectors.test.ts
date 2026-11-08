/**
 * Replays the golden vectors: every recorded client frame gets its verdict,
 * every server frame parses and matches the message builders, every binary
 * frame matches the encoders byte for byte.
 */
import { describe, expect, test } from 'bun:test';
import { helloNegotiate } from '../../../src/handlers/handler_hello.ts';
import { protocolMessageDecode } from '../../../src/protocol/protocol_message_decoder.ts';
import { binaryFrameEncode, transferFrameEncode } from '../../../src/shared/binary_frame.ts';
import { presenceFrameCheck, presenceFrameEncode, presenceFrameRelay } from '../../../src/shared/presence_frame.ts';
import type { ClientMessage } from '../../../src/shared/protocol_definitions.ts';
import { PROTOCOL_GOLDEN_VECTORS_V3 as V3, type GoldenVerdict } from '../../../src/shared/protocol_golden_vectors.ts';
import { protocolMismatchMessage, protocolUnsupportedMessage } from '../../../src/shared/protocol_versioning.ts';

/**
 * Computes the relay's verdict on one frame: decoding, then version negotiation
 * for hellos.
 *
 * @param frame Raw text frame.
 * @returns Verdict.
 */
function verdictOf(frame: string): GoldenVerdict {
  const decoded = protocolMessageDecode(frame);
  if (!decoded.ok) return 'reject';
  if (decoded.message.t !== 'hello') return 'accept';
  return helloNegotiate(decoded.message as Extract<ClientMessage, { t: 'hello' }>).ok ? 'accept' : 'refuse';
}

/**
 * Hex of a byte array.
 *
 * @param bytes Bytes.
 * @returns Lowercase hexadecimal.
 */
function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('protocol v3 golden vectors', () => {
  test.each(V3.client.map((vector) => [vector.name, vector] as const))('client %s', (_name, vector) => {
    expect(verdictOf(vector.frame)).toBe(vector.verdict);
  });

  test('server frames parse and carry the builders\u2019 messages', () => {
    const frames = new Map(V3.server.map((vector) => [vector.name, JSON.parse(vector.frame)]));
    expect(frames.get('protocol_unsupported').message).toBe(
      protocolUnsupportedMessage({ min: 1, max: 1 }, { min: 3, max: 3 }),
    );
    expect(frames.get('protocol_mismatch').message).toBe(protocolMismatchMessage(1, 3));
    for (const frame of frames.values()) expect(typeof frame.t).toBe('string');
  });

  test('binary frames match the encoders byte for byte', () => {
    const frame = presenceFrameEncode([{ id: 0, position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 90 }]);
    expect(presenceFrameCheck(frame)).toBe(true);
    const encoded = [
      binaryFrameEncode(1, 7, new Uint8Array([1, 2, 3])),
      frame,
      presenceFrameRelay(frame, 7),
      transferFrameEncode(5, 262144, new Uint8Array([1, 2, 3])),
    ];
    expect(encoded.map(hexOf)).toEqual(V3.binary.map((vector) => vector.hex));
  });
});
