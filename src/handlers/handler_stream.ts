/**
 * Owner-to-member snapshot and asset streams, relayed chunk by chunk with
 * credit-based flow control. Nothing is stored beyond the frames in flight.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import { Room, type RoomStream } from '../rooms/room.ts';
import type { ServerCore } from '../server/server_core.ts';
import { binaryFrameCopyWithPeer, binaryFrameParse } from '../shared/binary_frame.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { presenceCatchUp } from './handler_presence.ts';
import { roomMembershipEnd } from './handler_room.ts';

type StreamBeginMessage = Extract<ClientMessage, { t: 'stream.begin' }>;

/**
 * Credit is reported to the owner after at least this many bytes were
 * delivered.
 */
export const STREAM_CREDIT_STEP_BYTES = 256 * 1024;

/**
 * Returns the room when the sender owns it and the target is another member.
 *
 * @param session Sender.
 * @param to Target user id.
 * @returns Room and target, or null after replying with an error.
 */
function ownerRoomWithTarget(session: ConnectionSession, to: number): { room: Room; target: ConnectionSession } | null {
  const room = session.room;
  if (!room) return (sessionSendError(session, 'not_in_room', undefined), null);
  if (room.owner !== session) return (sessionSendError(session, 'not_owner', undefined), null);
  const target = room.members.get(to);
  if (!target || target === session)
    return (sessionSendError(session, 'stream_invalid', undefined, { to, detail: 'recipient not in room' }), null);
  return { room, target };
}

/**
 * Opens a stream from the owner to a member.
 *
 * @param core Relay core.
 * @param session Owner.
 * @param message Stream header.
 */
export function handlerStreamBegin(core: ServerCore, session: ConnectionSession, message: StreamBeginMessage): void {
  const resolved = ownerRoomWithTarget(session, message.to);
  if (!resolved) return;
  const { room, target } = resolved;
  const problem = streamBeginProblem(core, room, target, message);
  if (problem)
    return sessionSendError(session, 'stream_invalid', undefined, {
      to: message.to,
      stream: message.stream,
      detail: problem,
    });
  room.streams.set(Room.streamKey(target.user, message.stream), {
    to: target.user,
    id: message.stream,
    kind: message.kind,
    size: message.size,
    received: 0,
    delivered: 0,
    creditedAt: 0,
    ended: false,
  });
  if (message.kind === 'snapshot') target.awaitingSnapshotBegin = false;
  sessionSend(target, {
    t: 'stream.begin',
    from: session.user,
    stream: message.stream,
    kind: message.kind,
    size: message.size,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.mime === undefined ? {} : { mime: message.mime }),
  });
  if (message.size === 0)
    streamFinish(room, session, target, room.streams.get(Room.streamKey(target.user, message.stream)) as RoomStream);
}

/**
 * @param core Relay core.
 * @param room Room.
 * @param target Recipient.
 * @param message Stream header.
 * @returns Problem description or null.
 */
function streamBeginProblem(
  core: ServerCore,
  room: Room,
  target: ConnectionSession,
  message: StreamBeginMessage,
): string | null {
  if (room.streams.has(Room.streamKey(target.user, message.stream))) return 'stream id in use';
  if (room.streamCountFor(target.user) >= core.config.streamsPerRecipient) return 'too many streams';
  if (message.kind === 'snapshot') {
    if (!target.awaitingSnapshotBegin) return 'no snapshot requested';
    return message.size > core.config.snapshotBytesMaximum ? 'snapshot too large' : null;
  }
  if (message.name === undefined) return 'asset name required';
  return message.size > core.config.assetBytesMaximum ? 'asset too large' : null;
}

/**
 * Relays one binary chunk from the owner to the stream's recipient.
 *
 * @param core Relay core.
 * @param session Sender (must be the owner).
 * @param frame Raw binary frame.
 */
export function handlerStreamChunk(core: ServerCore, session: ConnectionSession, frame: Uint8Array): void {
  const header = binaryFrameParse(frame, core.config.streamChunkBytesMaximum);
  if (!header) return core.violation(session, 'malformed binary frame');
  const room = session.room;
  if (!room || room.owner !== session) return core.violation(session, 'binary frame from non-owner');
  const stream = room.streams.get(Room.streamKey(header.peer, header.stream));
  const target = room.members.get(header.peer);
  if (!stream || !target) return;
  const problem = streamChunkProblem(core, stream, header.payloadBytes);
  if (problem) return streamAbortBoth(room, session, target, stream, problem);
  stream.received += header.payloadBytes;
  const payloadBytes = header.payloadBytes;
  target.outbound.pushBinary(binaryFrameCopyWithPeer(frame, session.user), () =>
    streamDelivered(session, stream, payloadBytes),
  );
}

/**
 * @param core Relay core.
 * @param stream Stream state.
 * @param payloadBytes Chunk payload size.
 * @returns Problem description or null.
 */
function streamChunkProblem(core: ServerCore, stream: RoomStream, payloadBytes: number): string | null {
  if (stream.ended) return 'chunk after end';
  if (stream.received + payloadBytes > stream.size) return 'exceeds declared size';
  if (stream.received + payloadBytes - stream.delivered > core.config.streamWindowBytes) return 'window exceeded';
  return null;
}

/**
 * Tracks delivery and grants the owner credit in steps.
 *
 * @param owner Owner session.
 * @param stream Stream state.
 * @param payloadBytes Delivered payload bytes.
 */
function streamDelivered(owner: ConnectionSession, stream: RoomStream, payloadBytes: number): void {
  stream.delivered += payloadBytes;
  const complete = stream.delivered === stream.size;
  if (!complete && stream.delivered - stream.creditedAt < STREAM_CREDIT_STEP_BYTES) return;
  stream.creditedAt = stream.delivered;
  sessionSend(owner, { t: 'stream.credit', to: stream.to, stream: stream.id, delivered: stream.delivered });
}

/**
 * Completes a stream once exactly the declared size has been received.
 *
 * @param _core Relay core.
 * @param session Owner.
 * @param message End marker.
 */
export function handlerStreamEnd(
  _core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'stream.end' }>,
): void {
  const resolved = ownerRoomWithTarget(session, message.to);
  if (!resolved) return;
  const stream = resolved.room.streams.get(Room.streamKey(message.to, message.stream));
  if (!stream || stream.ended)
    return sessionSendError(session, 'stream_invalid', undefined, {
      to: message.to,
      stream: message.stream,
      detail: 'unknown stream',
    });
  if (stream.received !== stream.size)
    return streamAbortBoth(resolved.room, session, resolved.target, stream, 'size mismatch');
  streamFinish(resolved.room, session, resolved.target, stream);
}

/**
 * Sends the end marker to the recipient and forgets the stream. A finished
 * snapshot marks the recipient as synced.
 *
 * @param room Room.
 * @param owner Owner.
 * @param target Recipient.
 * @param stream Stream state.
 */
function streamFinish(room: Room, owner: ConnectionSession, target: ConnectionSession, stream: RoomStream): void {
  stream.ended = true;
  room.streams.delete(Room.streamKey(stream.to, stream.id));
  sessionSend(target, { t: 'stream.end', from: owner.user, stream: stream.id });
  if (stream.kind !== 'snapshot') return;
  target.synced = true;
  if (target.snapshotTimer) clearTimeout(target.snapshotTimer);
  target.snapshotTimer = null;
  presenceCatchUp(room, target);
}

/**
 * Owner-initiated abort. Aborting a snapshot removes the joiner from the room.
 *
 * @param core Relay core.
 * @param session Owner.
 * @param message Abort request.
 */
export function handlerStreamAbort(
  core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'stream.abort' }>,
): void {
  const resolved = ownerRoomWithTarget(session, message.to);
  if (!resolved) return;
  const stream = resolved.room.streams.get(Room.streamKey(message.to, message.stream));
  if (!stream) return;
  resolved.room.streams.delete(Room.streamKey(message.to, message.stream));
  sessionSend(resolved.target, {
    t: 'stream.abort',
    from: session.user,
    stream: stream.id,
    reason: message.reason ?? 'aborted',
  });
  if (stream.kind === 'snapshot' && !resolved.target.synced)
    roomMembershipEnd(core, resolved.target, 'snapshot_failed');
}

/**
 * Server-initiated abort, reported to both sides.
 *
 * @param room Room.
 * @param owner Owner.
 * @param target Recipient.
 * @param stream Stream state.
 * @param reason Reason text.
 */
function streamAbortBoth(
  room: Room,
  owner: ConnectionSession,
  target: ConnectionSession,
  stream: RoomStream,
  reason: string,
): void {
  room.streams.delete(Room.streamKey(stream.to, stream.id));
  stream.ended = true;
  sessionSend(owner, { t: 'stream.abort', to: target.user, stream: stream.id, reason });
  sessionSend(target, { t: 'stream.abort', from: owner.user, stream: stream.id, reason });
}

/**
 * A member asks the owner for an asset (e.g. a texture referenced by the
 * scene).
 *
 * @param _core Relay core.
 * @param session Member.
 * @param message Request.
 */
export function handlerAssetRequest(
  _core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'asset.request' }>,
): void {
  const room = session.room;
  if (!room) return sessionSendError(session, 'not_in_room', message.r);
  if (room.owner === session)
    return sessionSendError(session, 'stream_invalid', message.r, { detail: 'owner cannot request assets' });
  sessionSend(room.owner, { t: 'asset.request', from: session.user, name: message.name });
}

/**
 * The owner tells a member that a requested asset does not exist.
 *
 * @param _core Relay core.
 * @param session Owner.
 * @param message Notice.
 */
export function handlerAssetMissing(
  _core: ServerCore,
  session: ConnectionSession,
  message: Extract<ClientMessage, { t: 'asset.missing' }>,
): void {
  const resolved = ownerRoomWithTarget(session, message.to);
  if (resolved) sessionSend(resolved.target, { t: 'asset.missing', from: session.user, name: message.name });
}
