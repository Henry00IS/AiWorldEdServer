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
} from '../../src/shared/presence_frame.ts';

const CAMERA: PresenceEntry = {
  id: 0,
  position: [1.5, -2.25, 1000],
  quaternion: [0, 0.3826834, 0, 0.9238795],
  fov: 60,
};
const CHARACTER: PresenceEntry = { id: PRESENCE_ID_CHARACTER, position: [3, 0, -4], quaternion: [0, 0, 0, 1], fov: 0 };

/** Angle in degrees between two unit quaternions. */
function quaternionAngle(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a.reduce((total, value, index) => total + value * (b[index] ?? 0), 0));
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
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
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
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
    const good = presenceFrameEncode([CAMERA]);
    const variant = (offset: number, value: number) => {
      const copy = good.slice();
      copy[offset] = value;
      return copy;
    };
    const nonFinite = good.slice();
    new DataView(nonFinite.buffer).setFloat32(5, Number.NaN);
    const far = good.slice();
    new DataView(far.buffer).setFloat32(5, 2e6);
    const tooMany = presenceFrameEncode(Array.from({ length: 7 }, (_, id) => ({ ...CAMERA, id })));
    for (const frame of [
      variant(0, 0),
      variant(1, 1),
      variant(2, 9),
      variant(3, 2),
      variant(4, 16),
      variant(21, 0),
      variant(21, 180),
      good.subarray(0, 21),
      new Uint8Array([...good, 0]),
      nonFinite,
      far,
      tooMany,
      presenceFrameEncode([CAMERA, CAMERA]),
      presenceFrameEncode([{ ...CHARACTER, fov: 60 }]),
    ])
      expect(presenceFrameCheck(frame)).toBe(false);
    expect(PRESENCE_CLIENT_FRAME_BYTES_MAXIMUM).toBe(4 + 6 * PRESENCE_ENTRY_BYTES);
  });
});
