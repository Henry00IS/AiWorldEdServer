/**
 * Fixed 12 byte header for binary stream chunks: [0] magic 0xA7, [1] kind,
 * [2..3] reserved (0), [4..7] stream id (u32 BE), [8..11] peer user id (u32 BE;
 * recipient when sent by a client, sender when relayed). Transfer chunks (kind
 * 3) carry the download query id in [4..7] and the byte offset in [8..11].
 */
import {
  BINARY_FRAME_HEADER_BYTES,
  BINARY_FRAME_KIND_STREAM_CHUNK,
  BINARY_FRAME_KIND_TRANSFER_CHUNK,
  BINARY_FRAME_MAGIC,
} from './protocol_definitions.ts';

/** Decoded binary chunk header plus payload view. */
export interface BinaryStreamChunk {
  stream: number;
  peer: number;
  payloadBytes: number;
}

/**
 * Parses and validates a binary stream chunk header.
 *
 * @param frame Raw binary frame.
 * @param maximumPayloadBytes Largest accepted payload.
 * @returns Parsed header or null when the frame is malformed.
 */
export function binaryFrameParse(frame: Uint8Array, maximumPayloadBytes: number): BinaryStreamChunk | null {
  if (frame.byteLength <= BINARY_FRAME_HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint8(0) !== BINARY_FRAME_MAGIC || view.getUint8(1) !== BINARY_FRAME_KIND_STREAM_CHUNK) return null;
  if (view.getUint16(2) !== 0) return null;
  const stream = view.getUint32(4);
  const peer = view.getUint32(8);
  const payloadBytes = frame.byteLength - BINARY_FRAME_HEADER_BYTES;
  if (stream === 0 || peer === 0 || payloadBytes > maximumPayloadBytes) return null;
  return { stream, peer, payloadBytes };
}

/**
 * Copies a frame and rewrites the peer field (used when relaying).
 *
 * @param frame Original frame.
 * @param peer New peer user id.
 * @returns Independent copy with the peer replaced.
 */
export function binaryFrameCopyWithPeer(frame: Uint8Array, peer: number): Uint8Array {
  const copy = frame.slice();
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(8, peer);
  return copy;
}

/**
 * Builds a stream chunk frame (client helper, also used by tests).
 *
 * @param stream Stream id.
 * @param peer Peer user id.
 * @param payload Chunk bytes.
 * @returns Encoded frame.
 */
export function binaryFrameEncode(stream: number, peer: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(BINARY_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, BINARY_FRAME_MAGIC);
  view.setUint8(1, BINARY_FRAME_KIND_STREAM_CHUNK);
  view.setUint32(4, stream);
  view.setUint32(8, peer);
  frame.set(payload, BINARY_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Returns the payload of a stream chunk (client helper).
 *
 * @param frame Validated frame.
 * @returns View of the payload bytes (no copy).
 */
export function binaryFramePayload(frame: Uint8Array): Uint8Array {
  return frame.subarray(BINARY_FRAME_HEADER_BYTES);
}

/** Decoded transfer chunk frame. */
export interface BinaryTransferChunk {
  /** Download query id. */
  q: number;
  /** Byte offset of the chunk in the file. */
  offset: number;
  /** Chunk bytes (a view into the frame). */
  payload: Uint8Array;
}

/**
 * Builds a transfer chunk frame.
 *
 * @param q Download query id.
 * @param offset Byte offset of the chunk.
 * @param payload Chunk bytes.
 * @returns Encoded frame.
 */
export function transferFrameEncode(q: number, offset: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(BINARY_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = BINARY_FRAME_MAGIC;
  frame[1] = BINARY_FRAME_KIND_TRANSFER_CHUNK;
  view.setUint32(4, q);
  view.setUint32(8, offset);
  frame.set(payload, BINARY_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Parses a transfer chunk frame.
 *
 * @param frame Raw frame.
 * @returns Decoded chunk, or null when malformed.
 */
export function transferFrameParse(frame: Uint8Array): BinaryTransferChunk | null {
  if (frame.byteLength < BINARY_FRAME_HEADER_BYTES) return null;
  if (frame[0] !== BINARY_FRAME_MAGIC || frame[1] !== BINARY_FRAME_KIND_TRANSFER_CHUNK) return null;
  if (frame[2] !== 0 || frame[3] !== 0) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, BINARY_FRAME_HEADER_BYTES);
  const q = view.getUint32(4);
  if (q === 0) return null;
  return { q, offset: view.getUint32(8), payload: frame.subarray(BINARY_FRAME_HEADER_BYTES) };
}
