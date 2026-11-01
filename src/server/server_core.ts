/**
 * Transport-independent relay core: session lifecycle, rate limits and
 * dispatch.
 */
import type { ServerConfiguration } from '../config/server_configuration.ts';
import { ConnectionOutboundQueue, type OutboundSocket } from '../connection/connection_outbound_queue.ts';
import { sessionSend, type ConnectionSession, type ConnectionUpgradeData } from '../connection/connection_session.ts';
import { handlerEdit } from '../handlers/handler_edit.ts';
import { handlerPresence, presenceFlush } from '../handlers/handler_presence.ts';
import { handlerLockAcquire, handlerLockRelease } from '../handlers/handler_lock.ts';
import {
  handlerRoomCreate,
  handlerRoomJoin,
  handlerRoomLeave,
  handlerRoomList,
  roomMembershipEnd,
} from '../handlers/handler_room.ts';
import {
  handlerAssetMissing,
  handlerAssetRequest,
  handlerStreamAbort,
  handlerStreamBegin,
  handlerStreamChunk,
  handlerStreamEnd,
} from '../handlers/handler_stream.ts';
import { LimiterFailureWindow } from '../network/limiter_failure_window.ts';
import { LimiterKeyCounter } from '../network/limiter_key_counter.ts';
import { LimiterTokenBucket } from '../network/limiter_token_bucket.ts';
import { protocolMessageDecode } from '../protocol/protocol_message_decoder.ts';
import { PROTOCOL_CAPS } from '../protocol/protocol_message_schemas.ts';
import { RoomRegistry } from '../rooms/room_registry.ts';
import { displayNameFallback, displayNameNormalize, DISPLAY_NAME_LENGTH_MAXIMUM } from '../shared/room_name_policy.ts';
import {
  BINARY_FRAME_KIND_PRESENCE,
  CLOSE_CODES,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '../shared/protocol_definitions.ts';

/** Messages routed by the content dispatcher rather than the session dispatcher. */
type ContentMessage = Exclude<
  ClientMessage,
  { t: 'ping' | 'room.list' | 'room.create' | 'room.join' | 'room.leave' | 'hello' }
>;

/** Session fields that start from configuration defaults. */
type SessionInitialState = Omit<ConnectionSession, 'user' | 'clientIp' | 'ipKey' | 'via' | 'outbound' | 'close'>;

/**
 * Builds the rate limiters and initial flags of a new session.
 *
 * @param config Effective configuration.
 * @returns Fresh session state.
 */
function sessionInitialState(config: ServerConfiguration): SessionInitialState {
  return {
    messageBucket: new LimiterTokenBucket(config.messagesPerSecond, config.messageBurst),
    byteBucket: new LimiterTokenBucket(config.bytesPerSecond, config.byteBurst),
    presenceBucket: new LimiterTokenBucket(config.presencePerSecond, config.presenceBurst),
    presencePending: new Map(),
    presenceHighWaterBytes: config.presenceHighWaterBytes,
    name: '',
    helloDone: false,
    closed: false,
    room: null,
    synced: false,
    awaitingSnapshotBegin: false,
    snapshotTimer: null,
    handshakeTimer: null,
    pendingAsyncOperation: false,
  };
}

/**
 * Lists the effective limits announced in the welcome message.
 *
 * @param config Effective configuration.
 * @returns Limits object.
 */
function welcomeLimits(config: ServerConfiguration): object {
  return {
    maxPayloadBytes: config.maxPayloadBytes,
    streamChunkBytes: config.streamChunkBytesMaximum,
    streamWindowBytes: config.streamWindowBytes,
    snapshotBytes: config.snapshotBytesMaximum,
    assetBytes: config.assetBytesMaximum,
    idsPerMessage: PROTOCOL_CAPS.idsPerMessage,
    opsPerEdit: PROTOCOL_CAPS.opsPerEdit,
    messagesPerSecond: config.messagesPerSecond,
    roomsPerIp: config.roomsPerIp,
    usersPerRoom: config.usersPerRoomMaximum,
    locksPerUser: config.locksPerUser,
    presencePerSecond: config.presencePerSecond,
  };
}

/** Socket surface the core needs from the transport. */
export interface CoreSocket extends OutboundSocket {
  close(code: number, reason: string): void;
}

/**
 * Display name from the hello message. Older clients may send longer names;
 * they are cut to the maximum.
 *
 * @param rawName Name from hello, if any.
 * @param user User id for the fallback.
 * @returns Valid display name.
 */
function displayNameFromHello(rawName: string | undefined, user: number): string {
  const name = displayNameNormalize(
    Array.from(rawName?.trim() ?? '')
      .slice(0, DISPLAY_NAME_LENGTH_MAXIMUM)
      .join(''),
  );
  return name.ok ? name.name : displayNameFallback(user);
}

/** Relay state shared by every handler. */
export class ServerCore {
  readonly registry: RoomRegistry;
  readonly sessions = new Map<number, ConnectionSession>();
  readonly connectionsPerIpKey: LimiterKeyCounter;
  readonly joinFailuresPerIp: LimiterFailureWindow;
  readonly joinFailuresPerRoom: LimiterFailureWindow;
  passwordHashesInFlight = 0;
  private nextUserId = 1;
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  /**
   * Creates the relay core with its registry and limiters.
   *
   * @param config Effective configuration.
   */
  constructor(readonly config: ServerConfiguration) {
    this.registry = new RoomRegistry(config.roomsPerIp, config.roomsTotal);
    this.connectionsPerIpKey = new LimiterKeyCounter(config.connectionsPerIp);
    this.joinFailuresPerIp = new LimiterFailureWindow(config.joinFailuresPerIpPerMinute, 60_000);
    this.joinFailuresPerRoom = new LimiterFailureWindow(config.joinFailuresPerRoomPerMinute, 60_000);
    this.pruneTimer = setInterval(() => this.limitersPrune(), 60_000);
  }

  /**
   * Reserves a connection slot for an address during the HTTP upgrade.
   *
   * @param ipKey Address limit key.
   * @returns True when the connection may proceed.
   */
  connectionReserve(ipKey: string): boolean {
    if (this.sessions.size >= this.config.connectionsTotal) return false;
    return this.connectionsPerIpKey.tryAcquire(ipKey);
  }

  /**
   * Creates the session for a freshly upgraded socket and arms the handshake
   * timer.
   *
   * @param socket Transport socket.
   * @param data Upgrade data.
   * @returns New session.
   */
  sessionOpen(socket: CoreSocket, data: ConnectionUpgradeData): ConnectionSession {
    const session = this.sessionCreate(socket, data);
    this.sessions.set(session.user, session);
    session.handshakeTimer = setTimeout(
      () => session.close(CLOSE_CODES.handshakeTimeout, 'handshake timeout'),
      this.config.handshakeTimeoutMs,
    );
    return session;
  }

  /**
   * Handles one inbound frame.
   *
   * @param session Sender.
   * @param frame Text or binary frame.
   */
  sessionMessage(session: ConnectionSession, frame: string | Uint8Array): void {
    if (session.closed) return;
    const frameBytes = typeof frame === 'string' ? frame.length : frame.byteLength;
    if (!session.messageBucket.take(1) || !session.byteBucket.take(frameBytes)) {
      session.close(CLOSE_CODES.rateLimited, 'rate limited');
      return;
    }
    if (typeof frame !== 'string') this.sessionBinary(session, frame);
    else this.sessionText(session, frame);
  }

  /**
   * Continues flushing after the socket drained.
   *
   * @param session Session whose socket drained.
   */
  sessionDrain(session: ConnectionSession): void {
    session.outbound.flush();
  }

  /**
   * Cleans up a closed connection: leaves its room, frees locks and its slot.
   *
   * @param session Closed session.
   */
  sessionClosed(session: ConnectionSession): void {
    if (session.closed) return;
    session.closed = true;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    roomMembershipEnd(this, session, 'disconnected');
    session.outbound.clear();
    this.sessions.delete(session.user);
    this.connectionsPerIpKey.release(session.ipKey);
  }

  /** Closes every connection and stops timers. */
  shutdown(): void {
    clearInterval(this.pruneTimer);
    for (const session of [...this.sessions.values()]) session.close(CLOSE_CODES.shuttingDown, 'server shutting down');
  }

  /**
   * Closes a session for a protocol violation.
   *
   * @param session Offender.
   * @param reason Short reason (sent in the close frame).
   */
  violation(session: ConnectionSession, reason: string): void {
    session.close(CLOSE_CODES.protocolViolation, reason.slice(0, 120));
  }

  /**
   * Creates the session object for a newly opened socket.
   *
   * @param socket Transport socket.
   * @param data Upgrade data.
   * @returns Fresh session object.
   */
  private sessionCreate(socket: CoreSocket, data: ConnectionUpgradeData): ConnectionSession {
    const config = this.config;
    let session: ConnectionSession;
    const outbound = new ConnectionOutboundQueue(
      socket,
      config.outboundQueueBytesMaximum,
      config.socketBufferHighWaterBytes,
      () => session.close(CLOSE_CODES.slowConsumer, 'slow consumer'),
    );
    session = {
      user: this.userIdNext(),
      clientIp: data.clientIp,
      ipKey: data.ipKey,
      via: data.via,
      outbound,
      close: (code, reason) => socket.close(code, reason),
      ...sessionInitialState(config),
    };
    outbound.idleListener = () => presenceFlush(session);
    return session;
  }

  /**
   * Allocates the next free user id.
   *
   * @returns Next user id, wrapping within u32 and skipping ids in use.
   */
  private userIdNext(): number {
    do {
      this.nextUserId = this.nextUserId >= 0xffffffff ? 1 : this.nextUserId + 1;
    } while (this.sessions.has(this.nextUserId));
    return this.nextUserId;
  }

  /**
   * Routes a binary frame to the presence or stream handler.
   *
   * @param session Sender.
   * @param frame Binary frame.
   */
  private sessionBinary(session: ConnectionSession, frame: Uint8Array): void {
    if (!session.helloDone) return this.violation(session, 'binary before hello');
    if (frame[1] === BINARY_FRAME_KIND_PRESENCE) return handlerPresence(this, session, frame);
    handlerStreamChunk(this, session, frame);
  }

  /**
   * Decodes a text frame and routes it to the handshake or a message handler.
   *
   * @param session Sender.
   * @param text Text frame.
   */
  private sessionText(session: ConnectionSession, text: string): void {
    const decoded = protocolMessageDecode(text);
    if (!decoded.ok) return this.violation(session, decoded.reason);
    if (!session.helloDone) return this.handshake(session, decoded.message);
    if (decoded.message.t === 'hello') return this.violation(session, 'duplicate hello');
    this.dispatch(session, decoded.message);
  }

  /**
   * Validates the hello message and replies with welcome.
   *
   * @param session Sender.
   * @param message First message of the connection.
   */
  private handshake(session: ConnectionSession, message: ClientMessage): void {
    if (message.t !== 'hello') return this.violation(session, 'expected hello');
    if (message.version !== PROTOCOL_VERSION)
      return this.violation(session, `unsupported version, server speaks ${PROTOCOL_VERSION}`);
    session.name = displayNameFromHello(message.name, session.user);
    session.helloDone = true;
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.handshakeTimer = null;
    sessionSend(session, this.welcomeMessage(session));
  }

  /**
   * Builds the welcome message sent after a successful hello.
   *
   * @param session Recipient.
   * @returns Welcome message with the effective limits.
   */
  private welcomeMessage(session: ConnectionSession): object {
    return {
      t: 'welcome',
      protocol: PROTOCOL_ID,
      version: PROTOCOL_VERSION,
      user: session.user,
      name: session.name,
      via: session.via,
      limits: welcomeLimits(this.config),
    };
  }

  /**
   * Routes a validated message to its handler.
   *
   * @param session Sender.
   * @param message Validated message.
   */
  private dispatch(session: ConnectionSession, message: ClientMessage): void {
    switch (message.t) {
      case 'ping':
        return sessionSend(session, { t: 'pong', ...(message.r === undefined ? {} : { r: message.r }) });
      case 'room.list':
        return handlerRoomList(this, session, message);
      case 'room.create':
        return void handlerRoomCreate(this, session, message);
      case 'room.join':
        return void handlerRoomJoin(this, session, message);
      case 'room.leave':
        return handlerRoomLeave(this, session, message);
      case 'hello':
        return this.violation(session, 'duplicate hello');
      default:
        return this.dispatchContent(session, message);
    }
  }

  /**
   * Routes a validated lock, edit, asset or stream message to its handler.
   *
   * @param session Sender.
   * @param message Validated message.
   */
  private dispatchContent(session: ConnectionSession, message: ContentMessage): void {
    switch (message.t) {
      case 'lock.acquire':
        return handlerLockAcquire(this, session, message);
      case 'lock.release':
        return handlerLockRelease(this, session, message);
      case 'edit':
        return handlerEdit(this, session, message);
      case 'asset.request':
        return handlerAssetRequest(this, session, message);
      case 'asset.missing':
        return handlerAssetMissing(this, session, message);
      case 'stream.begin':
        return handlerStreamBegin(this, session, message);
      case 'stream.end':
        return handlerStreamEnd(this, session, message);
      case 'stream.abort':
        return handlerStreamAbort(this, session, message);
    }
  }

  /** Drops expired failure windows. */
  private limitersPrune(): void {
    this.joinFailuresPerIp.prune();
    this.joinFailuresPerRoom.prune();
  }
}
