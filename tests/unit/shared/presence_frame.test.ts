import { describe, expect, test } from 'bun:test';
import {
  PRESENCE_CLIENT_FRAME_BYTES_MAXIMUM,
  PRESENCE_ENTRY_BYTES,
  PRESENCE_ID_CHARACTER,
  presenceFrameCheck,
  presenceFrameDecode,
  presenceFrameEncode,
  presenceFrameRelay,
  presenceQuaternionPack,
  presenceQuaternionUnpack,
  type PresenceEntry,
} from '../../../src/shared/presence_frame.ts';

const CAMERA: PresenceEntry = {
  id: 0,
  position: [1.5, -2.25, 1000],
  quaternion: [0, 0.3826834, 0, 0.9238795],
  fov: 60,
};
const CHARACTER: PresenceEntry = { id: PRESENCE_ID_CHARACTER, position: [3, 0, -4], quaternion: [0, 0, 0, 1], fov: 0 };

/**
 * Measures the angle in degrees between two unit quaternions.
 *
 * @param a First quaternion.
 * @param b Second quaternion.
 * @returns Angle in degrees.
 */
function quaternionAngle(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a.reduce((total, value, index) => total + value * (b[index] ?? 0), 0));
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/**
 * Creates a deterministic pseudo random generator in the range -1 to 1.
 *
 * @param seed Non-zero start value.
 * @returns Generator returning the next value on every call.
 */
function randomSignedSequence(seed: number): () => number {
  let state = seed;
  return () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/**
 * Copies a frame with one byte replaced.
 *
 * @param frame Source frame.
 * @param offset Byte offset to replace.
 * @param value New byte value.
 * @returns Modified copy.
 */
function frameByteReplaced(frame: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = frame.slice();
  copy[offset] = value;
  return copy;
}

describe('presence frame', () => {
  test('one camera costs 22 bytes up and 26 down; round trips through the relay', () => {
    const frame = presenceFrameEncode([CAMERA, CHARACTER]);
    expect(presenceFrameEncode([CAMERA]).byteLength).toBe(22);
    expect(presenceFrameRelay(presenceFrameEncode([CAMERA]), 7).byteLength).toBe(26);
    expect(presenceFrameCheck(frame)).toBe(true);
    const decoded = presenceFrameDecode(presenceFrameRelay(frame, 42));
    expect(decoded?.sender).toBe(42);
    expect(decoded?.entries.map((entry) => [entry.id, entry.position, entry.fov])).toEqual([
      [0, [1.5, -2.25, 1000], 60],
      [255, [3, 0, -4], 0],
    ]);
    expect(quaternionAngle(decoded?.entries[0]?.quaternion ?? [], CAMERA.quaternion)).toBeLessThan(0.2);
  });

  test('an empty frame (presence cleared) is valid', () => {
    const decoded = presenceFrameDecode(presenceFrameRelay(presenceFrameEncode([]), 3));
    expect(decoded).toEqual({ sender: 3, entries: [] });
  });

  test('quaternions survive smallest-three packing within 0.2 degrees', () => {
    const random = randomSignedSequence(1);
    for (let index = 0; index < 2000; index++) {
      const raw = [random(), random(), random(), random()];
      const length = Math.hypot(...raw);
      const unit = raw.map((value) => value / length);
      const [x, y, z, w] = unit as [number, number, number, number];
      const back = presenceQuaternionUnpack(presenceQuaternionPack(x, y, z, w));
      expect(quaternionAngle(back, unit)).toBeLessThan(0.2);
    }
  });

  test('any 32 bit value unpacks to a unit quaternion', () => {
    for (const packed of [0, 0xffffffff, 0x80000000, 0x3fffffff, 123456789]) {
      expect(Math.hypot(...presenceQuaternionUnpack(packed))).toBeCloseTo(1, 6);
    }
  });

  test('rejects malformed frames', () => {
    for (const frame of framesMalformed(presenceFrameEncode([CAMERA]))) expect(presenceFrameCheck(frame)).toBe(false);
    expect(PRESENCE_CLIENT_FRAME_BYTES_MAXIMUM).toBe(4 + 6 * PRESENCE_ENTRY_BYTES);
  });
});

/**
 * Copies a frame with one big-endian float replaced.
 *
 * @param frame Source frame.
 * @param offset Byte offset of the float.
 * @param value New float value.
 * @returns Modified copy.
 */
function frameFloatReplaced(frame: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = frame.slice();
  new DataView(copy.buffer).setFloat32(offset, value);
  return copy;
}

/**
 * Builds malformed variants of a valid one-camera frame.
 *
 * @param good Valid one-camera client frame.
 * @returns Frames the check must reject.
 */
function framesMalformed(good: Uint8Array): Uint8Array[] {
  const tooMany = presenceFrameEncode(Array.from({ length: 7 }, (_, id) => ({ ...CAMERA, id })));
  return [
    frameByteReplaced(good, 0, 0),
    frameByteReplaced(good, 1, 1),
    frameByteReplaced(good, 2, 9),
    frameByteReplaced(good, 3, 2),
    frameByteReplaced(good, 4, 16),
    frameByteReplaced(good, 21, 0),
    frameByteReplaced(good, 21, 180),
    good.subarray(0, 21),
    new Uint8Array([...good, 0]),
    frameFloatReplaced(good, 5, Number.NaN),
    frameFloatReplaced(good, 5, 2e6),
    tooMany,
    presenceFrameEncode([CAMERA, CAMERA]),
    presenceFrameEncode([{ ...CHARACTER, fov: 60 }]),
  ];
}
