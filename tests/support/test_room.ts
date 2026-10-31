/**
 * Room helpers for integration tests: create an internal test room, answer snapshot requests and receive streams.
 */
import { expect } from 'bun:test';
import { binaryFrameEncode, binaryFrameParse, binaryFramePayload } from '../../src/shared/binary_frame.ts';
import type { TestClient } from './test_client.ts';

/** Creates an internal test room and returns its id. */
export async function roomCreate(owner: TestClient, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await owner.request({ t: 'room.create', name: `test room ${Math.random()}`, private: false, internalTest: true, ...extra }, 'room.created');
  expect(reply.t).toBe('room.created');
  return reply.room.id;
}

/** Owner answers the pending snapshot request with the given bytes. */
export async function snapshotSend(owner: TestClient, snapshot: Uint8Array, streamId = 1): Promise<number> {
  const request = await owner.next('snapshot.request');
  owner.send({ t: 'stream.begin', to: request.for, stream: streamId, kind: 'snapshot', size: snapshot.byteLength });
  for (let offset = 0; offset < snapshot.byteLength; offset += 64 * 1024) {
    owner.sendRaw(binaryFrameEncode(streamId, request.for, snapshot.subarray(offset, offset + 64 * 1024)));
  }
  owner.send({ t: 'stream.end', to: request.for, stream: streamId });
  return request.for;
}

/**
 * Joins with an already connected client and receives the full snapshot.
 *
 * @param joiner Connected client.
 * @param owner Room owner.
 * @param roomId Room id.
 * @param snapshot Snapshot bytes the owner sends.
 * @param extra Extra join request fields.
 * @returns The joiner and the received snapshot bytes.
 */
export async function testRoomJoinSynced(joiner: TestClient, owner: TestClient, roomId: string, snapshot: Uint8Array = new TextEncoder().encode('{"world":1}'), extra: Record<string, unknown> = {}): Promise<{ joiner: TestClient; received: Uint8Array }> {
  const joined = await joiner.request({ t: 'room.join', room: roomId, discardLocalWork: true, ...extra }, 'room.joined');
  expect(joined.t).toBe('room.joined');
  await snapshotSend(owner, snapshot);
  return { joiner, received: await streamReceive(joiner) };
}

/** Collects one stream on the receiving side. */
export async function streamReceive(receiver: TestClient): Promise<Uint8Array> {
  const begin = await receiver.next('stream.begin');
  const parts: Uint8Array[] = [];
  let received = 0;
  while (received < begin.size) {
    const frame = await receiver.nextBinary();
    const chunk = binaryFrameParse(frame, 1 << 20);
    if (!chunk) throw new Error('bad chunk');
    expect(chunk.stream).toBe(begin.stream);
    expect(chunk.peer).toBe(begin.from);
    parts.push(binaryFramePayload(frame).slice());
    received += chunk.payloadBytes;
  }
  await receiver.next('stream.end', (message) => message.stream === begin.stream);
  const result = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) result.set(part, (offset += part.byteLength) - part.byteLength);
  return result;
}
