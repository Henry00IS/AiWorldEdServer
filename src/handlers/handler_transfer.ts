/**
 * Transfer links: an editor registers a link for a file it keeps in memory and
 * serves the bytes on demand while somebody downloads the link over HTTP. See
 * src/transfer/ for the token format and the chunk scheduling.
 */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { ServerCore } from '../server/server_core.ts';
import { transferFrameParse } from '../shared/binary_frame.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { TransferOwner } from '../transfer/transfer_owner.ts';
import { transferChunkReceived, transferInfoReceived, transferOwnerClosed } from '../transfer/transfer_stream.ts';
import { abuseRecord, abuseThrottled } from './handler_abuse.ts';

/** Client transfer messages. */
type TransferClientMessage = Extract<ClientMessage, { t: 'transfer.create' | 'transfer.info' | 'transfer.missing' }>;

/** Abuse points for a link request faster than the interval. */
const TRANSFER_ABUSE_POINTS_RATE = 2;
/** Abuse points for a chunk or answer nobody waits for. */
const TRANSFER_ABUSE_POINTS_STALE = 1;

/**
 * Routes a transfer message; only sessions that agreed on `transfer` may send
 * them.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Validated message.
 */
export function handlerTransfer(core: ServerCore, session: ConnectionSession, message: TransferClientMessage): void {
  if (!session.protocol.caps.has('transfer')) return core.violation(session, 'transfer capability not agreed');
  if (message.t === 'transfer.create') return transferCreate(core, session, message.r);
  const owner = session.transfer;
  if (owner === null || !owner.downloads.has(message.q)) {
    return abuseRecord(core, session, TRANSFER_ABUSE_POINTS_STALE, 'unexpected transfer answer');
  }
  const info = message.t === 'transfer.info' ? { size: message.size, name: message.name, mime: message.mime } : null;
  transferInfoReceived(owner, message.q, info);
}

/**
 * Handles `transfer.create`: one link per interval, refused while throttled.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param r Request id.
 */
function transferCreate(core: ServerCore, session: ConnectionSession, r: number | undefined): void {
  const owner = transferOwnerOf(core, session);
  const now = Date.now();
  const retryAfterMs = Math.max(owner.retryAfterMs(now), abuseThrottled(core, session) ? 1000 : 0);
  if (retryAfterMs > 0) {
    abuseRecord(core, session, TRANSFER_ABUSE_POINTS_RATE, 'transfer links too fast');
    return sessionSendError(session, 'transfer_rate_limited', r, { retryAfterMs });
  }
  const link = core.transferCodec.encode(session.user, owner.linkCreate(now), owner.nonce);
  const expiresInMs = core.config.transferLinkLifetimeMs;
  sessionSend(session, { t: 'transfer.created', ...(r === undefined ? {} : { r }), link, expiresInMs });
}

/**
 * Returns the transfer state of a session, creating it on first use.
 *
 * @param core Relay core.
 * @param session Session.
 * @returns Owner state.
 */
function transferOwnerOf(core: ServerCore, session: ConnectionSession): TransferOwner {
  const config = core.config;
  session.transfer ??= new TransferOwner(
    {
      intervalMs: config.transferCreateIntervalMs,
      lifetimeMs: config.transferLinkLifetimeMs,
      chunkBytes: config.transferChunkBytes,
      sizeMaximum: config.transferSizeMaximum,
      downloads: config.transferDownloadsPerOwner,
      timeoutMs: config.transferReplyTimeoutMs,
    },
    (message) => sessionSend(session, message),
  );
  return session.transfer;
}

/**
 * Handles a transfer chunk frame of a link owner.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param frame Binary frame.
 */
export function handlerTransferChunk(core: ServerCore, session: ConnectionSession, frame: Uint8Array): void {
  const chunk = transferFrameParse(frame);
  if (chunk === null || session.transfer === null) {
    return abuseRecord(core, session, TRANSFER_ABUSE_POINTS_STALE, 'invalid transfer chunk');
  }
  const result = transferChunkReceived(session.transfer, chunk.q, chunk.offset, chunk.payload);
  if (result === 'invalid') abuseRecord(core, session, TRANSFER_ABUSE_POINTS_STALE, 'transfer chunk out of order');
  if (result === 'stale') abuseRecord(core, session, TRANSFER_ABUSE_POINTS_STALE, 'unexpected transfer chunk');
}

/**
 * Finds the live owner of a link token.
 *
 * @param core Relay core.
 * @param link Token.
 * @returns Owner state, or null for an unknown, expired or revoked link.
 */
export function handlerTransferLinkOwner(core: ServerCore, link: string): TransferOwner | null {
  const parts = core.transferCodec.parts(link);
  const owner = parts === null ? null : (core.sessions.get(parts.user)?.transfer ?? null);
  if (parts === null || owner === null || !core.transferCodec.verify(link, owner.nonce)) return null;
  return owner.linkAlive(parts.counter, Date.now()) ? owner : null;
}

/**
 * Ends the downloads of a closed session; its links die with it.
 *
 * @param session Closed session.
 */
export function transferSessionClosed(session: ConnectionSession): void {
  if (session.transfer !== null) transferOwnerClosed(session.transfer);
}
