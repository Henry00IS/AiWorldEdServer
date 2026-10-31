import { expect, test } from 'bun:test';
import { binaryFrameCopyWithPeer, binaryFrameEncode, binaryFrameParse } from '../../src/shared/binary_frame.ts';

test('encodes, parses and rewrites the peer field', () => {
  const frame = binaryFrameEncode(42, 7, new Uint8Array([1, 2, 3]));
  expect(frame.byteLength).toBe(15);
  const parsed = binaryFrameParse(frame, 1024);
  expect(parsed).toMatchObject({ stream: 42, peer: 7, payloadBytes: 3 });
  const rewritten = binaryFrameCopyWithPeer(frame, 9);
  expect(binaryFrameParse(rewritten, 1024)).toMatchObject({ stream: 42, peer: 9, payloadBytes: 3 });
  expect(binaryFrameParse(frame, 1024)?.peer).toBe(7);
});

test('rejects bad magic, kind, reserved bytes, short and oversized frames', () => {
  const frame = binaryFrameEncode(1, 1, new Uint8Array(8));
  for (const [offset, value] of [[0, 0x00], [1, 9], [2, 1]] as const) {
    const bad = frame.slice();
    bad[offset] = value;
    expect(binaryFrameParse(bad, 1024)).toBeNull();
  }
  expect(binaryFrameParse(frame.slice(0, 11), 1024)).toBeNull();
  expect(binaryFrameParse(frame, 4)).toBeNull();
  expect(binaryFrameParse(binaryFrameEncode(1, 1, new Uint8Array(0)), 1024)).toBeNull();
});
