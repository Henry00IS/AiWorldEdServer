/** Per-connection state. */
import type { LimiterTokenBucket } from '../network/limiter_token_bucket.ts';
import type { Room } from '../rooms/room.ts';
import type { ConnectionOutboundQueue } from './connection_outbound_queue.ts';
import type { ConnectionVerifyState } from './connection_verify_state.ts';

/** Data captured at upgrade time and attached to the WebSocket. */
export interface ConnectionUpgradeData {
  clientIp: string;
  ipKey: string;
  via: 'direct' | 'proxy';
}

/** Everything the relay knows about one connected client. */
export interface ConnectionSession {
  readonly user: number;
  readonly clientIp: string;
  readonly ipKey: string;
  readonly via: 'direct' | 'proxy';
  readonly outbound: ConnectionOutboundQueue;
  readonly messageBucket: LimiterTokenBucket;
  readonly byteBucket: LimiterTokenBucket;
  readonly presenceBucket: LimiterTokenBucket;
  /** Presence mailbox: latest undelivered relayed frame per sender. */
  readonly presencePending: Map<number, Uint8Array>;
  /** Socket buffer level above which presence waits. */
  readonly presenceHighWaterBytes: number;
  /**
   * Serialized chat messages from other members waiting for an idle outbound
   * queue, oldest first.
   */
  readonly chatPending: string[];
  /** Time of the last accepted chat message (epoch ms). */
  chatLastAt: number;
  readonly close: (code: number, reason: string) => void;
  /** Display name in the current room (unique there), else the chosen name. */
  name: string;
  /** Display name the user chose; a room may add a number to make it unique. */
  nameChosen: string;
  helloDone: boolean;
  closed: boolean;
  room: Room | null;
  synced: boolean;
  awaitingSnapshotBegin: boolean;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pendingAsyncOperation: boolean;
  /** Owner verification of claimed ancestors: open query and held messages. */
  readonly verify: ConnectionVerifyState;
}

/**
 * Serializes and queues a JSON message for a session.
 *
 * @param session Recipient.
 * @param message Message object.
 */
export function sessionSend(session: ConnectionSession, message: object): void {
  if (session.closed) return;
  session.outbound.pushText(JSON.stringify(message));
}

/**
 * Queues an error reply.
 *
 * @param session Recipient.
 * @param code Error code.
 * @param requestId Request id to echo, if any.
 * @param details Extra fields.
 */
export function sessionSendError(
  session: ConnectionSession,
  code: string,
  requestId: number | undefined,
  details: object = {},
): void {
  sessionSend(session, { t: 'error', code, ...(requestId === undefined ? {} : { r: requestId }), ...details });
}
