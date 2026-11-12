import { describe, expect, test } from 'bun:test';
import {
  TOY_CLIENT_HEADER_BYTES,
  TOY_ENTRIES_MAXIMUM,
  TOY_ENTRY_FIXED_BYTES,
  TOY_FLAG_GROUNDED,
  TOY_FLAG_SLEEPING,
  TOY_PAYLOAD_BYTES_MAXIMUM,
  TOY_POSITION_UNITS_MAXIMUM,
  TOY_PRECISION_BITS_MAXIMUM,
  TOY_RELAY_HEADER_BYTES,
  TOY_TYPE_TENNIS_BALL,
  toyFrameCheck,
  toyFrameDecode,
  toyFrameEncode,
  toyFrameIsFull,
  toyFramePrecision,
  toyFrameRelay,
  type ToyEntry,
} from '../../../src/shared/toy_frame.ts';

/** Bytes of a tennis ball payload. */
const BALL_PAYLOAD_BYTES = 7;

/**
 * Builds an entry with a recognizable payload at an exactly stored position
 * near the origin of changes().
 *
 * @param id Toy id.
 * @param type Toy type.
 * @param length Payload length.
 * @returns Entry.
 */
function toy(id: number, type = TOY_TYPE_TENNIS_BALL, length = BALL_PAYLOAD_BYTES): ToyEntry {
  const payload = Uint8Array.from({ length }, (_value, index) => (id * 16 + index) & 0xff);
  return { type, id, flags: 0, position: [1.5 + id, -2.25, 1000 - id / 512], payload };
}

/**
 * Encodes a changes-only frame at tick 7.
 *
 * @param entries Entries.
 * @returns Client frame.
 */
function changes(entries: ToyEntry[]): Uint8Array {
  return toyFrameEncode({ full: false, tick: 7, bits: 9, origin: [1.5, -2, 1000], entries });
}

/**
 * Encodes two balls and lets a callback damage the bytes.
 *
 * @param damage Changes the frame in place.
 * @returns Damaged frame.
 */
function damaged(damage: (frame: Uint8Array, view: DataView) => void): Uint8Array {
  const frame = changes([toy(1), toy(2)]);
  damage(frame, new DataView(frame.buffer));
  return frame;
}

describe('toy frames', () => {
  test('a ball entry is 17 bytes, so one ball is 37 bytes up and 41 bytes down', () => {
    const frame = changes([toy(1)]);
    expect(TOY_ENTRY_FIXED_BYTES + BALL_PAYLOAD_BYTES).toBe(17);
    expect(frame.byteLength).toBe(37);
    expect(toyFrameRelay(frame, 3).byteLength).toBe(41);
    const largest = changes([1, 2, 3, 4].map((id) => toy(id, 9, TOY_PAYLOAD_BYTES_MAXIMUM)));
    expect([largest.byteLength, toyFrameRelay(largest, 3).byteLength]).toEqual([148, 152]);
    expect(toyFrameCheck(largest)).toBe(true);
  });

  test('round-trips fixed parts, positions and opaque payloads through the relay with the sender as owner', () => {
    const resting = { ...toy(2, 200, 0), flags: TOY_FLAG_SLEEPING | TOY_FLAG_GROUNDED };
    const origin: [number, number, number] = [1, -2, 1000];
    const frame = toyFrameEncode({ full: true, tick: 70_000, bits: 9, origin, entries: [toy(1), resting] });
    expect(toyFrameCheck(frame)).toBe(true);
    expect(toyFrameIsFull(frame)).toBe(true);
    const decoded = toyFrameDecode(toyFrameRelay(frame, 4));
    expect(decoded).toEqual({
      sender: 4,
      full: true,
      tick: 70_000 & 0xffff,
      bits: 9,
      origin,
      entries: [toy(1), resting],
    });
  });

  test('an empty full frame clears the sender; an empty changes-only frame is invalid', () => {
    const frame = toyFrameEncode({ full: true, tick: 3, bits: 0, origin: [0, 0, 0], entries: [] });
    expect(frame.byteLength).toBe(TOY_CLIENT_HEADER_BYTES);
    expect(toyFrameDecode(toyFrameRelay(frame, 1))?.entries).toEqual([]);
    expect(toyFrameCheck(changes([]))).toBe(false);
  });

  test('rejects bad headers, envelopes and inconsistent or oversized lengths', () => {
    const second = TOY_CLIENT_HEADER_BYTES + TOY_ENTRY_FIXED_BYTES + BALL_PAYLOAD_BYTES;
    const bad = [
      damaged((frame) => (frame[2] = 2)),
      damaged((frame) => (frame[3] = 1)),
      damaged((frame) => (frame[3] = 3)),
      damaged((frame) => (frame[4] = 2)),
      damaged((frame) => (frame[7] = TOY_PRECISION_BITS_MAXIMUM + 1)),
      damaged((_frame, view) => view.setFloat32(12, Number.NaN)),
      damaged((_frame, view) => view.setFloat32(16, 2e6)),
      damaged((frame) => (frame[second] = 0)),
      damaged((frame) => (frame[second + 1] = 1)),
      damaged((frame) => (frame[second + 1] = TOY_ENTRIES_MAXIMUM + 1)),
      damaged((frame) => (frame[second + 2] = 4)),
      damaged((frame) => (frame[second + 3] = BALL_PAYLOAD_BYTES + 1)),
      damaged((frame) => (frame[second + 3] = BALL_PAYLOAD_BYTES - 1)),
      changes([toy(1, 1, TOY_PAYLOAD_BYTES_MAXIMUM + 1)]),
      changes([toy(1)]).subarray(0, 30),
      toyFrameRelay(changes([toy(1)]), 2),
    ];
    bad.forEach((frame) => expect(toyFrameCheck(frame)).toBe(false));
    expect(toyFrameDecode(changes([toy(1)]).subarray(0, TOY_RELAY_HEADER_BYTES - 1))).toBeNull();
  });

  test('picks the finest precision that fits, clamps far positions and accepts every stored value', () => {
    expect(toyFramePrecision([])).toEqual({ origin: [0, 0, 0], bits: TOY_PRECISION_BITS_MAXIMUM });
    expect(
      toyFramePrecision([
        [-300, 0, 1],
        [300, 4, 1],
      ]),
    ).toEqual({ origin: [0, 2, 1], bits: 6 });
    const far = { ...toy(1), position: [1e5, -1e5, 1000] as [number, number, number] };
    const decoded = toyFrameDecode(toyFrameRelay(changes([far]), 2))?.entries[0]?.position ?? [];
    const reach = TOY_POSITION_UNITS_MAXIMUM / 512;
    expect(decoded).toEqual([1.5 + reach, -2 - reach, 1000]);
    const lowest = changes([toy(1)]);
    new DataView(lowest.buffer).setInt16(TOY_CLIENT_HEADER_BYTES + 4, -32768);
    expect(toyFrameCheck(lowest)).toBe(true);
  });

  test('any toy type passes the envelope check; a frame lists at most four toys', () => {
    expect(toyFrameCheck(changes([toy(1, 255, 0), toy(2, 77, TOY_PAYLOAD_BYTES_MAXIMUM)]))).toBe(true);
    const many = Array.from({ length: TOY_ENTRIES_MAXIMUM + 1 }, (_value, index) => toy(1 + (index % 4)));
    expect(toyFrameCheck(changes(many.slice(0, TOY_ENTRIES_MAXIMUM)))).toBe(true);
    expect(toyFrameCheck(changes(many))).toBe(false);
  });
});
