/**
 * Toy frames: low-priority, latest-only state of the toys a room member owns
 * and simulates (temporary player-owned props such as the tennis balls it
 * threw). Every member publishes only its own toys; the relay stamps the
 * sender, which is the owner of every toy in the frame. The relay validates
 * only the envelope, so new toy types never need a relay change; clients
 * validate the payloads of the types they know and ignore the others.
 * Dependency-free, shared by relay and client.
 *
 * Client frame (20-byte header): [0] magic 0xA7, [1] kind 5, [2] format
 * version, [3] entry count (at most TOY_ENTRIES_MAXIMUM), [4] frame flags
 * (TOY_FRAME_FULL: the frame lists every toy of the sender and toys missing
 * from it are gone; without it, only toys that changed are listed), [5..6]
 * sender simulation tick (u16 BE, 120 Hz, wraps), [7] position precision bits k
 * (0..TOY_PRECISION_BITS_MAXIMUM) of the entry positions, [8..19] position
 * origin (3 x float32 BE), then the entries. Relayed frame: the same with the
 * sender user id (u32 BE) inserted after byte 3.
 *
 * Entry: 10-byte fixed part [0] toy type (1..255, see TOY_TYPE__), [1] toy id
 * (1..TOY_ID_MAXIMUM, unique in the frame), [2] entry flags (TOY_FLAG__, other
 * bits zero; type-specific flags belong in the payload), [3] payload length
 * (0..TOY_PAYLOAD_BYTES_MAXIMUM), [4..9] position (3 x int16 BE, meters =
 * origin + value / 2^k; every value is valid), then the type-specific payload,
 * opaque to the relay. A type needing finer positions adds its own correction
 * to its payload.
 */
import { BINARY_FRAME_KIND_TOY, BINARY_FRAME_MAGIC } from './protocol_definitions.ts';

/** Toy payload format version. */
export const TOY_FORMAT_VERSION = 1;
/** Most toys one member owns, and so most entries in one frame. */
export const TOY_ENTRIES_MAXIMUM = 4;
/** Largest toy id (one id per toy a member may own). */
export const TOY_ID_MAXIMUM = TOY_ENTRIES_MAXIMUM;
/** Bytes of the fixed part of an entry (type, id, flags, length, position). */
export const TOY_ENTRY_FIXED_BYTES = 10;
/** Largest payload of one entry (an entry is at most 32 bytes). */
export const TOY_PAYLOAD_BYTES_MAXIMUM = 22;
/** Largest stored position magnitude (int16, keeping -32768 unused). */
export const TOY_POSITION_UNITS_MAXIMUM = 32767;
/** Header bytes of a client frame. */
export const TOY_CLIENT_HEADER_BYTES = 20;
/** Header bytes of a relayed frame. */
export const TOY_RELAY_HEADER_BYTES = 24;
/** Bytes before the sender id in a relayed frame (magic, kind, version, count). */
const TOY_SENDER_OFFSET = 4;
/** Largest accepted absolute origin coordinate. */
export const TOY_POSITION_LIMIT = 1e6;
/** Finest position precision: 2^-9 m (about 2 mm, within 64 m of the origin). */
export const TOY_PRECISION_BITS_MAXIMUM = 9;
/** Frame flag: the frame lists every toy of the sender. */
export const TOY_FRAME_FULL = 1;
/** Entry flag: the toy rests and will not move until disturbed. */
export const TOY_FLAG_SLEEPING = 1;
/** Entry flag: the toy moves along a surface (no gravity arc). */
export const TOY_FLAG_GROUNDED = 2;
/** Every defined entry flag bit. */
export const TOY_FLAGS_MASK = TOY_FLAG_SLEEPING | TOY_FLAG_GROUNDED;
/** Toy type: a thrown tennis ball (7-byte payload, see the editor). */
export const TOY_TYPE_TENNIS_BALL = 1;

/** One entry: fixed fields, the position in meters and the opaque payload. */
export interface ToyEntry {
  type: number;
  id: number;
  flags: number;
  position: [number, number, number];
  payload: Uint8Array;
}

/** One snapshot: a full list or the changed toys, at a sender tick. */
export interface ToySnapshot {
  full: boolean;
  tick: number;
  /** Position precision bits k of the entries. */
  bits: number;
  /** Position origin of the entries (float32 values). */
  origin: [number, number, number];
  entries: ToyEntry[];
}

/** A decoded relayed frame; the sender owns every entry. */
export interface ToyFrame extends ToySnapshot {
  sender: number;
}

/**
 * Validates a client frame: version, at most TOY_ENTRIES_MAXIMUM entries,
 * defined frame flags, precision, a finite bounded origin, and entries whose
 * fixed parts are valid and whose lengths add up to the exact frame length. A
 * changes-only frame must list at least one toy.
 *
 * @param frame Raw binary frame from a client.
 * @returns True when the frame is well formed.
 */
export function toyFrameCheck(frame: Uint8Array): boolean {
  if (frame.byteLength < TOY_CLIENT_HEADER_BYTES) return false;
  if (frame[0] !== BINARY_FRAME_MAGIC || frame[1] !== BINARY_FRAME_KIND_TOY) return false;
  const count = frame[3] ?? 0;
  if (frame[2] !== TOY_FORMAT_VERSION || count > TOY_ENTRIES_MAXIMUM) return false;
  const flags = frame[4] ?? 0;
  if ((flags & ~TOY_FRAME_FULL) !== 0 || (count === 0 && flags === 0)) return false;
  if ((frame[7] ?? 0) > TOY_PRECISION_BITS_MAXIMUM) return false;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return toyOriginCheck(view) && toyEntriesCheck(frame, count);
}

/**
 * Checks that the origin is finite and within TOY_POSITION_LIMIT.
 *
 * @param view Frame view.
 * @returns True when valid.
 */
function toyOriginCheck(view: DataView): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const value = view.getFloat32(8 + axis * 4);
    if (!Number.isFinite(value) || Math.abs(value) > TOY_POSITION_LIMIT) return false;
  }
  return true;
}

/**
 * Walks the fixed entry parts: known flags, ids unique and in range, non-zero
 * types, payloads within the maximum, and the exact frame length. Positions
 * need no check.
 *
 * @param frame Client frame.
 * @param count Entry count.
 * @returns True when every entry is valid.
 */
function toyEntriesCheck(frame: Uint8Array, count: number): boolean {
  const ids = new Set<number>();
  let offset = TOY_CLIENT_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    if (offset + TOY_ENTRY_FIXED_BYTES > frame.byteLength) return false;
    const id = frame[offset + 1] ?? 0;
    const length = frame[offset + 3] ?? 0;
    if (frame[offset] === 0 || id === 0 || id > TOY_ID_MAXIMUM || ids.has(id)) return false;
    if (((frame[offset + 2] ?? 0) & ~TOY_FLAGS_MASK) !== 0 || length > TOY_PAYLOAD_BYTES_MAXIMUM) return false;
    ids.add(id);
    offset += TOY_ENTRY_FIXED_BYTES + length;
  }
  return offset === frame.byteLength;
}

/**
 * Tells whether a validated client or relayed frame lists every toy of its
 * sender.
 *
 * @param frame Validated frame.
 * @returns True for a full frame.
 */
export function toyFrameIsFull(frame: Uint8Array): boolean {
  return ((frame[4] ?? 0) & TOY_FRAME_FULL) !== 0;
}

/**
 * Builds the relayed copy of a validated client frame.
 *
 * @param frame Validated client frame.
 * @param sender Sender user id, the owner of every entry.
 * @returns Frame for the other members.
 */
export function toyFrameRelay(frame: Uint8Array, sender: number): Uint8Array {
  const relayed = new Uint8Array(frame.byteLength + 4);
  relayed.set(frame.subarray(0, TOY_SENDER_OFFSET), 0);
  new DataView(relayed.buffer).setUint32(TOY_SENDER_OFFSET, sender);
  relayed.set(frame.subarray(TOY_SENDER_OFFSET), TOY_SENDER_OFFSET + 4);
  return relayed;
}

/**
 * Picks the position origin (center of the positions' bounds, as float32) and
 * the finest precision that still fits every position.
 *
 * @param positions Entry positions in meters.
 * @returns Origin and precision bits.
 */
export function toyFramePrecision(positions: readonly (readonly number[])[]): Pick<ToySnapshot, 'origin' | 'bits'> {
  const origin: [number, number, number] = [0, 0, 0];
  let reach = 0;
  for (let axis = 0; axis < 3 && positions.length > 0; axis++) {
    const values = positions.map((position) => position[axis] ?? 0);
    origin[axis] = Math.fround((Math.min(...values) + Math.max(...values)) / 2);
    reach = Math.max(reach, ...values.map((value) => Math.abs(value - (origin[axis] ?? 0))));
  }
  let bits = TOY_PRECISION_BITS_MAXIMUM;
  while (bits > 0 && reach * 2 ** bits > TOY_POSITION_UNITS_MAXIMUM) bits--;
  return { origin, bits };
}

/**
 * Encodes a client frame; positions are rounded to the precision and clamped to
 * the int16 range. Callers keep entries within the documented limits.
 *
 * @param snapshot Full list or changed toys, the sender tick and the origin.
 * @returns Client frame.
 */
export function toyFrameEncode(snapshot: ToySnapshot): Uint8Array {
  const entries = snapshot.entries;
  const size = entries.reduce((sum, entry) => sum + TOY_ENTRY_FIXED_BYTES + entry.payload.byteLength, 0);
  const frame = new Uint8Array(TOY_CLIENT_HEADER_BYTES + size);
  const view = new DataView(frame.buffer);
  frame.set([BINARY_FRAME_MAGIC, BINARY_FRAME_KIND_TOY, TOY_FORMAT_VERSION, entries.length], 0);
  frame[4] = snapshot.full ? TOY_FRAME_FULL : 0;
  view.setUint16(5, snapshot.tick & 0xffff);
  frame[7] = snapshot.bits;
  snapshot.origin.forEach((value, axis) => view.setFloat32(8 + axis * 4, value));
  let offset = TOY_CLIENT_HEADER_BYTES;
  for (const entry of entries) {
    frame.set([entry.type, entry.id, entry.flags, entry.payload.byteLength], offset);
    entry.position.forEach((value, axis) => {
      const units = Math.round((value - (snapshot.origin[axis] ?? 0)) * 2 ** snapshot.bits);
      view.setInt16(
        offset + 4 + axis * 2,
        Math.max(-TOY_POSITION_UNITS_MAXIMUM, Math.min(TOY_POSITION_UNITS_MAXIMUM, units)),
      );
    });
    frame.set(entry.payload, offset + TOY_ENTRY_FIXED_BYTES);
    offset += TOY_ENTRY_FIXED_BYTES + entry.payload.byteLength;
  }
  return frame;
}

/**
 * Decodes a relayed frame; payloads are copied, not interpreted.
 *
 * @param frame Raw binary frame from the relay.
 * @returns Sender and snapshot, or null when the envelope is malformed.
 */
export function toyFrameDecode(frame: Uint8Array): ToyFrame | null {
  if (frame.byteLength < TOY_RELAY_HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const sender = view.getUint32(TOY_SENDER_OFFSET);
  const client = new Uint8Array(frame.byteLength - 4);
  client.set(frame.subarray(0, TOY_SENDER_OFFSET), 0);
  client.set(frame.subarray(TOY_SENDER_OFFSET + 4), TOY_SENDER_OFFSET);
  if (sender === 0 || !toyFrameCheck(client)) return null;
  const header = new DataView(client.buffer);
  const origin: [number, number, number] = [header.getFloat32(8), header.getFloat32(12), header.getFloat32(16)];
  const snapshot = { full: toyFrameIsFull(client), tick: header.getUint16(5), bits: client[7] ?? 0, origin };
  return { sender, ...snapshot, entries: toyEntriesRead(client, header, snapshot) };
}

/**
 * Reads the entries of a validated client frame.
 *
 * @param client Validated client frame.
 * @param view View over it.
 * @param frame Origin and precision of the positions.
 * @returns Entries with positions in meters and copied payloads.
 */
function toyEntriesRead(client: Uint8Array, view: DataView, frame: Pick<ToySnapshot, 'origin' | 'bits'>): ToyEntry[] {
  const entries: ToyEntry[] = [];
  let offset = TOY_CLIENT_HEADER_BYTES;
  for (let index = 0; index < (client[3] ?? 0); index++) {
    const length = client[offset + 3] ?? 0;
    const at = offset;
    const position = frame.origin.map((origin, axis) => origin + view.getInt16(at + 4 + axis * 2) / 2 ** frame.bits);
    const payload = client.slice(offset + TOY_ENTRY_FIXED_BYTES, offset + TOY_ENTRY_FIXED_BYTES + length);
    const fixed = { type: client[offset] ?? 0, id: client[offset + 1] ?? 0, flags: client[offset + 2] ?? 0 };
    entries.push({ ...fixed, position: position as [number, number, number], payload });
    offset += TOY_ENTRY_FIXED_BYTES + length;
  }
  return entries;
}
