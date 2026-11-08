/** Third-party binary envelope; application payload bytes are never interpreted. */
import { BINARY_FRAME_KIND_CUSTOM, BINARY_FRAME_MAGIC } from './protocol_definitions.ts';

/** Optional scene lock guard for a preview; never a saved-scene edit. */
export interface CustomGuard {
  broadcast?: boolean;
  lease?: number;
  ids?: string[];
}
/** Decoded envelope; guard must be schema-validated by the relay. */
export interface CustomFrame {
  r: number;
  peer: number;
  guard: unknown;
  payload: Uint8Array;
}

/**
 * Encodes opaque data with an optional, separate JSON lock envelope.
 *
 * @param r Sender correlation id.
 * @param peer Target user, or zero to address the owner.
 * @param payload Opaque application bytes.
 * @param guard Optional scene lease and ids.
 * @returns Binary frame.
 */
export function customFrameEncode(r: number, peer: number, payload: Uint8Array, guard: CustomGuard = {}): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(guard));
  if (metadata.length > 16384) throw new Error('Custom guard too large');
  const frame = new Uint8Array(12 + metadata.length + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = BINARY_FRAME_MAGIC;
  frame[1] = BINARY_FRAME_KIND_CUSTOM;
  view.setUint16(2, metadata.length);
  view.setUint32(4, r);
  view.setUint32(8, peer);
  frame.set(metadata, 12);
  frame.set(payload, 12 + metadata.length);
  return frame;
}

/**
 * Reads only the routing and lock envelope, never the application payload.
 *
 * @param frame Binary frame.
 * @returns Envelope or null for malformed framing.
 */
export function customFrameParse(frame: Uint8Array): CustomFrame | null {
  if (frame.length < 12 || frame[0] !== BINARY_FRAME_MAGIC || frame[1] !== BINARY_FRAME_KIND_CUSTOM) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint16(2);
  if (length > 16384 || frame.length < 12 + length) return null;
  try {
    const guard: unknown =
      length === 0 ? {} : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(12, 12 + length)));
    return { r: view.getUint32(4), peer: view.getUint32(8), guard, payload: frame.subarray(12 + length) };
  } catch {
    return null;
  }
}
