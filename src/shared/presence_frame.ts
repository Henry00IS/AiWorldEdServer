/**
 * Presence frames: the low-priority, latest-only pose of a member's viewport
 * cameras and play-mode character. Dependency-free, shared by relay and
 * client.
 *
 * Client frame: [0] magic 0xA7, [1] kind 2, [2] format version, [3] entry
 * count, then the entries. Relayed frame: the same with the sender user id (u32
 * BE) inserted after the count. Entry (18 bytes): [0] id (camera slot 0..15, or
 * 0xFF for the character), [1..12] position (3 x float32 BE), [13..16]
 * orientation (smallest-three quaternion in 32 bits), [17] vertical field of
 * view in degrees (1..179 for cameras, 0 for the character).
 */
import { BINARY_FRAME_KIND_PRESENCE, BINARY_FRAME_MAGIC } from './protocol_definitions.ts';

/** Presence payload format version. */
export const PRESENCE_FORMAT_VERSION = 1;
/** Bytes per presence entry. */
export const PRESENCE_ENTRY_BYTES = 18;
/** Most entries in one frame (cameras plus the character). */
export const PRESENCE_ENTRIES_MAXIMUM = 6;
/** Highest camera slot id. */
export const PRESENCE_CAMERA_ID_MAXIMUM = 15;
/** Entry id of the play-mode character. */
export const PRESENCE_ID_CHARACTER = 0xff;
/** Header bytes of a client frame. */
export const PRESENCE_CLIENT_HEADER_BYTES = 4;
/** Header bytes of a relayed frame. */
export const PRESENCE_RELAY_HEADER_BYTES = 8;
/** Largest accepted absolute coordinate. */
export const PRESENCE_POSITION_LIMIT = 1e6;
/** Largest client frame in bytes. */
export const PRESENCE_CLIENT_FRAME_BYTES_MAXIMUM =
  PRESENCE_CLIENT_HEADER_BYTES + PRESENCE_ENTRIES_MAXIMUM * PRESENCE_ENTRY_BYTES;

/**
 * Scale of one packed quaternion component (10 bits over [-1/sqrt(2),
 * 1/sqrt(2)]).
 */
const PRESENCE_QUATERNION_RANGE = Math.SQRT1_2;
/** Largest value of a 10 bit component. */
const PRESENCE_QUATERNION_STEPS = 1023;

/** One decoded presence entry. */
export interface PresenceEntry {
  id: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
}

/** A decoded relayed presence frame. */
export interface PresenceFrame {
  sender: number;
  entries: PresenceEntry[];
}

/**
 * Validates a client presence frame: exact length, version, unique ids, finite
 * bounded positions and a field of view matching the entry kind.
 *
 * @param frame Raw binary frame from a client.
 * @returns True when the frame is well formed.
 */
export function presenceFrameCheck(frame: Uint8Array): boolean {
  if (
    frame.byteLength < PRESENCE_CLIENT_HEADER_BYTES ||
    frame[0] !== BINARY_FRAME_MAGIC ||
    frame[1] !== BINARY_FRAME_KIND_PRESENCE
  )
    return false;
  const count = frame[3] ?? 0;
  if (frame[2] !== PRESENCE_FORMAT_VERSION || count > PRESENCE_ENTRIES_MAXIMUM) return false;
  if (frame.byteLength !== PRESENCE_CLIENT_HEADER_BYTES + count * PRESENCE_ENTRY_BYTES) return false;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const ids = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = PRESENCE_CLIENT_HEADER_BYTES + index * PRESENCE_ENTRY_BYTES;
    if (!presenceEntryCheck(view, offset) || ids.has(view.getUint8(offset))) return false;
    ids.add(view.getUint8(offset));
  }
  return true;
}

/**
 * Validates one entry.
 *
 * @param view Frame view.
 * @param offset Entry offset.
 * @returns True when the entry is well formed.
 */
function presenceEntryCheck(view: DataView, offset: number): boolean {
  const id = view.getUint8(offset);
  const fov = view.getUint8(offset + 17);
  if (id === PRESENCE_ID_CHARACTER ? fov !== 0 : id > PRESENCE_CAMERA_ID_MAXIMUM || fov < 1 || fov > 179) return false;
  for (let axis = 0; axis < 3; axis++) {
    const value = view.getFloat32(offset + 1 + axis * 4);
    if (!Number.isFinite(value) || Math.abs(value) > PRESENCE_POSITION_LIMIT) return false;
  }
  return true;
}

/**
 * Builds the relayed copy of a validated client frame with the sender inserted.
 *
 * @param frame Validated client frame.
 * @param sender Sender user id.
 * @returns Frame for the other members.
 */
export function presenceFrameRelay(frame: Uint8Array, sender: number): Uint8Array {
  const relayed = new Uint8Array(frame.byteLength + PRESENCE_RELAY_HEADER_BYTES - PRESENCE_CLIENT_HEADER_BYTES);
  relayed.set(frame.subarray(0, PRESENCE_CLIENT_HEADER_BYTES), 0);
  new DataView(relayed.buffer).setUint32(PRESENCE_CLIENT_HEADER_BYTES, sender);
  relayed.set(frame.subarray(PRESENCE_CLIENT_HEADER_BYTES), PRESENCE_RELAY_HEADER_BYTES);
  return relayed;
}

/**
 * Encodes a client presence frame. Callers keep entries within the documented
 * limits.
 *
 * @param entries Entries to send (an empty list clears the sender's presence).
 * @returns Client frame.
 */
export function presenceFrameEncode(entries: readonly PresenceEntry[]): Uint8Array {
  const frame = new Uint8Array(PRESENCE_CLIENT_HEADER_BYTES + entries.length * PRESENCE_ENTRY_BYTES);
  const view = new DataView(frame.buffer);
  frame.set([BINARY_FRAME_MAGIC, BINARY_FRAME_KIND_PRESENCE, PRESENCE_FORMAT_VERSION, entries.length], 0);
  entries.forEach((entry, index) =>
    presenceEntryWrite(view, PRESENCE_CLIENT_HEADER_BYTES + index * PRESENCE_ENTRY_BYTES, entry),
  );
  return frame;
}

/**
 * Writes one entry.
 *
 * @param view Frame view.
 * @param offset Entry offset.
 * @param entry Entry to write.
 */
function presenceEntryWrite(view: DataView, offset: number, entry: PresenceEntry): void {
  view.setUint8(offset, entry.id);
  entry.position.forEach((value, axis) => view.setFloat32(offset + 1 + axis * 4, value));
  const [x, y, z, w] = entry.quaternion;
  view.setUint32(offset + 13, presenceQuaternionPack(x, y, z, w));
  view.setUint8(offset + 17, entry.fov);
}

/**
 * Decodes a relayed presence frame.
 *
 * @param frame Raw binary frame from the relay.
 * @returns Sender and entries, or null when malformed.
 */
export function presenceFrameDecode(frame: Uint8Array): PresenceFrame | null {
  if (frame.byteLength < PRESENCE_RELAY_HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const sender = view.getUint32(PRESENCE_CLIENT_HEADER_BYTES);
  const client = new Uint8Array(frame.byteLength - PRESENCE_RELAY_HEADER_BYTES + PRESENCE_CLIENT_HEADER_BYTES);
  client.set(frame.subarray(0, PRESENCE_CLIENT_HEADER_BYTES), 0);
  client.set(frame.subarray(PRESENCE_RELAY_HEADER_BYTES), PRESENCE_CLIENT_HEADER_BYTES);
  if (sender === 0 || !presenceFrameCheck(client)) return null;
  const clientView = new DataView(client.buffer);
  const entries: PresenceEntry[] = [];
  for (let index = 0; index < (client[3] ?? 0); index++)
    entries.push(presenceEntryRead(clientView, PRESENCE_CLIENT_HEADER_BYTES + index * PRESENCE_ENTRY_BYTES));
  return { sender, entries };
}

/**
 * Reads one validated entry.
 *
 * @param view Frame view.
 * @param offset Entry offset.
 * @returns Entry.
 */
function presenceEntryRead(view: DataView, offset: number): PresenceEntry {
  const position: [number, number, number] = [
    view.getFloat32(offset + 1),
    view.getFloat32(offset + 5),
    view.getFloat32(offset + 9),
  ];
  return {
    id: view.getUint8(offset),
    position,
    quaternion: presenceQuaternionUnpack(view.getUint32(offset + 13)),
    fov: view.getUint8(offset + 17),
  };
}

/**
 * Packs a unit quaternion with the smallest-three scheme: 2 bits name the
 * dropped largest component, 3 x 10 bits hold the others (about 0.1 degree
 * resolution).
 *
 * @param x X component.
 * @param y Y component.
 * @param z Z component.
 * @param w W component.
 * @returns Packed 32 bit value.
 */
export function presenceQuaternionPack(x: number, y: number, z: number, w: number): number {
  const components = [x, y, z, w];
  let largest = 0;
  components.forEach((value, index) => {
    if (Math.abs(value) > Math.abs(components[largest] ?? 0)) largest = index;
  });
  const sign = (components[largest] ?? 0) < 0 ? -1 : 1;
  let packed = largest;
  components.forEach((value, index) => {
    if (index !== largest) packed = packed * 1024 + presenceQuaternionQuantize(value * sign);
  });
  return packed >>> 0;
}

/**
 * Maps one small component to 10 bits.
 *
 * @param value Component in [-1/sqrt(2), 1/sqrt(2)].
 * @returns Quantized value 0..1023.
 */
function presenceQuaternionQuantize(value: number): number {
  const unit =
    (Math.max(-PRESENCE_QUATERNION_RANGE, Math.min(PRESENCE_QUATERNION_RANGE, value)) / PRESENCE_QUATERNION_RANGE + 1) /
    2;
  return Math.round((Number.isFinite(unit) ? unit : 0.5) * PRESENCE_QUATERNION_STEPS);
}

/**
 * Unpacks a smallest-three quaternion; any 32 bit value yields a unit
 * quaternion.
 *
 * @param packed Packed value.
 * @returns Components x, y, z, w.
 */
export function presenceQuaternionUnpack(packed: number): [number, number, number, number] {
  const largest = Math.floor(packed / 2 ** 30) & 3;
  const small = [(packed >>> 20) & 1023, (packed >>> 10) & 1023, packed & 1023]
    .map((step) => (step / PRESENCE_QUATERNION_STEPS) * 2 - 1)
    .map((unit) => unit * PRESENCE_QUATERNION_RANGE);
  const sum = small.reduce((total, value) => total + value * value, 0);
  const result: number[] = [...small];
  result.splice(largest, 0, Math.sqrt(Math.max(0, 1 - sum)));
  const length = Math.hypot(...result) || 1;
  return result.map((value) => value / length) as [number, number, number, number];
}
