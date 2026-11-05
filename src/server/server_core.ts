/**
 * Transport-independent relay core: session lifecycle, rate limits and
 * dispatch.
 */
import type { ServerConfiguration } from '../config/server_configuration.ts';
import { ConnectionOutboundQueue, type OutboundSocket } from '../connection/connection_outbound_queue.ts';
import { ConnectionVerifyState, type ConnectionVerifyHeldMessage } from '../connection/connection_verify_state.ts';
import { handlerVerifyResult, verifyHoldOrRun } from '../handlers/handler_verify.ts';
import {
  sessionSend,
  type ConnectionEditLimits,
  type ConnectionSession,
  type ConnectionUpgradeData,
} from '../connection/connection_session.ts';
import { handlerEdit } from '../handlers/handler_edit.ts';
import { chatFlush, handlerChat } from '../handlers/handler_chat.ts';
import { handlerNameSet } from '../handlers/handler_name.ts';
import { handlerPresence, presenceFlush } from '../handlers/handler_presence.ts';
import { handlerLockAcquire, handlerLockRelease, handlerLockRenew, leasesSweep } from '../handlers/handler_lock.ts';
import { handlerSelect } from '../handlers/handler_select.ts';
import { handlerTyping } from '../handlers/handler_typing.ts';
import { handlerTransfer, handlerTransferChunk, transferSessionClosed } from '../handlers/handler_transfer.ts';
import { TransferLinkCodec } from '../transfer/transfer_link_codec.ts';
import { ServerOnlineStats, SERVER_ONLINE_STATS_CAPABILITY } from './server_online_stats.ts';
import { helloNegotiate, helloRefuse } from '../handlers/handler_hello.ts';
import { PROTOCOL_VERSION_MAXIMUM, PROTOCOL_VERSION_MINIMUM } from '../shared/protocol_versioning.ts';
import { LimiterAbuseCarry, type LimiterAbuseScore } from '../network/limiter_abuse_score.ts';
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
import { LimiterKeyedTokenBucket } from '../network/limiter_keyed_token_bucket.ts';
import { LimiterSharedBudget } from '../network/limiter_shared_budget.ts';
import { LimiterTokenBucket } from '../network/limiter_token_bucket.ts';
import { protocolMessageDecode } from '../protocol/protocol_message_decoder.ts';
import { PROTOCOL_CAPS } from '../protocol/protocol_message_schemas.ts';
import { RoomListSubscriptions } from '../rooms/room_list_subscriptions.ts';
import { RoomRegistry } from '../rooms/room_registry.ts';
import { handlerRoomSubscribe, handlerRoomUnsubscribe } from '../handlers/handler_room_subscription.ts';
import { displayNameFallback, displayNameNormalize, DISPLAY_NAME_LENGTH_MAXIMUM } from '../shared/room_name_policy.ts';
import {
  BINARY_FRAME_KIND_PRESENCE,
  BINARY_FRAME_KIND_TRANSFER_CHUNK,
  CLOSE_CODES,
  PROTOCOL_ID,
  type ClientMessage,
} from '../shared/protocol_definitions.ts';

/** Messages routed by the content dispatcher rather than the session dispatcher. */
type ContentMessage = Exclude<
  ClientMessage,
  {
    t:
      | 'ping'
      | 'room.list'
      | 'room.subscribe'
      | 'room.unsubscribe'
      | 'room.create'
      | 'room.join'
      | 'room.leave'
      | 'name.set'
      | 'hello';
  }
>;

/** Session fields that start from configuration defaults. */
type SessionInitialState = Omit<
  ConnectionSession,
  'user' | 'clientIp' | 'ipKey' | 'via' | 'outbound' | 'close' | 'limits'
>;

/**
 * Builds the presence limiter and buffers of a new session.
 *
 * @param config Effective configuration.
 * @returns Fresh presence state.
 */
function sessionPresenceState(
  config: ServerConfiguration,
): Pick<SessionInitialState, 'presenceBucket' | 'presencePending' | 'presenceHighWaterBytes'> {
  return {
    presenceBucket: new LimiterTokenBucket(config.presencePerSecond, config.presenceBurst),
    presencePending: new Map(),
    presenceHighWaterBytes: config.presenceHighWaterBytes,
  };
}

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
    ...sessionPresenceState(config),
    chatPending: [],
    chatLastAt: Number.NEGATIVE_INFINITY,
    name: '',
    nameChosen: '',
    helloDone: false,
    protocol: { version: 0, caps: new Set(), client: '' },
    closed: false,
    room: null,
    synced: false,
    awaitingSnapshotBegin: false,
    snapshotTimer: null,
    handshakeTimer: null,
    pendingAsyncOperation: false,
    verify: sessionVerifyState(config),
    transfer: null,
  };
}

/**
 * Builds the owner verification state of a new session.
 *
 * @param config Effective configuration.
 * @returns Idle verification state.
 */
function sessionVerifyState(config: ServerConfiguration): ConnectionVerifyState {
  return new ConnectionVerifyState({
    perSecond: config.verifyPerMemberPerSecond,
    burst: config.verifyPerMemberBurst,
    heldMessagesMaximum: config.verifyQueueMessagesMaximum,
    heldBytesMaximum: config.verifyQueueBytesMaximum,
  });
}

/**
 * Builds the edit, lease and selection limits of a new session.
 *
 * @param config Effective configuration.
 * @param abuse Abuse score carried over from the address.
 * @returns Fresh limits.
 */
function sessionEditLimits(config: ServerConfiguration, abuse: LimiterAbuseScore): ConnectionEditLimits {
  return {
    leaseBucket: new LimiterTokenBucket(config.leasesPerSecond, config.leaseBurst),
    renewBucket: new LimiterTokenBucket(config.leaseRenewsPerSecond, config.leaseRenewBurst),
    oneShotBucket: new LimiterTokenBucket(config.oneShotEditsPerSecond, config.oneShotEditBurst),
    liveBucket: new LimiterTokenBucket(config.liveEditsPerSecond, config.liveEditBurst),
    bulkIdsBucket: new LimiterTokenBucket(config.bulkIdsPerSecond, config.bulkIdBurst),
    selectBucket: new LimiterTokenBucket(config.selectsPerSecond, config.selectBurst),
    abuse,
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
    roomEntriesPerIpPerMinute: config.roomEntriesPerIpPerMinute,
    usersPerRoom: config.usersPerRoomMaximum,
    locksPerUser: config.locksPerUser,
    presencePerSecond: config.presencePerSecond,
    ...welcomeLimitsRooms(config),
  };
}

/**
 * Lists the lease, room list and chat limits announced in the welcome message.
 *
 * @param config Effective configuration.
 * @returns Limits object fields.
 */
function welcomeLimitsRooms(config: ServerConfiguration): object {
  return {
    lockLeaseMs: config.lockLeaseMs,
    roomListMaximum: config.roomListMaximum,
    roomListPushIntervalMs: config.roomListPushIntervalMs,
    chatIntervalMs: config.chatIntervalMs,
    chatTextLength: config.chatTextLengthMaximum,
    chatTextLines: config.chatTextLinesMaximum,
    transferIntervalMs: config.transferCreateIntervalMs,
    transferLifetimeMs: config.transferLinkLifetimeMs,
    transferBytes: config.transferSizeMaximum,
  };
}

/**
 * Creates the room list subscription hub.
 *
 * @param config Effective configuration.
 * @param registry Room registry it lists.
 * @returns Subscription hub.
 */
function roomListSubscriptionsCreate(config: ServerConfiguration, registry: RoomRegistry): RoomListSubscriptions {
  return new RoomListSubscriptions({
    rooms: () => registry.all(),
    subscribersMaximum: config.roomListSubscribersMaximum,
    roomListMaximum: config.roomListMaximum,
    pushIntervalMs: config.roomListPushIntervalMs,
    lowPriorityHighWaterBytes: config.presenceHighWaterBytes,
  });
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

/**
 * Sends low-priority traffic once a session's outbound queue is empty: chat
 * first, then presence.
 *
 * @param session Session whose queue drained.
 */
function sessionIdle(session: ConnectionSession): void {
  chatFlush(session);
  presenceFlush(session);
}

/** Relay state shared by every handler. */
export class ServerCore {
  readonly registry: RoomRegistry;
  readonly roomListSubscriptions: RoomListSubscriptions;
  readonly sessions = new Map<number, ConnectionSession>();
  readonly connectionsPerIpKey: LimiterKeyCounter;
  readonly joinFailuresPerIp: LimiterFailureWindow;
  readonly joinFailuresPerRoom: LimiterFailureWindow;
  readonly passwordWorkPerIpKey: LimiterKeyCounter;
  readonly roomEntriesPerIpKey: LimiterKeyedTokenBucket;
  readonly locksServerBudget: LimiterSharedBudget;
  readonly outboundBacklogServerBudget: LimiterSharedBudget;
  passwordHashesInFlight = 0;
  private nextUserId = 1;
  readonly abuseCarry: LimiterAbuseCarry;
  /** Issues and checks transfer link tokens with this process's secret. */
  readonly transferCodec = new TransferLinkCodec();
  /**
   * Broadcasts the live connection count to members with the `stats`
   * capability.
   */
  readonly onlineStats = new ServerOnlineStats(this.sessions);
  private readonly pruneTimer: ReturnType<typeof setInterval>;
  private readonly leaseTimer: ReturnType<typeof setInterval>;

  /**
   * Creates the relay core with its registry and limiters.
   *
   * @param config Effective configuration.
   */
  constructor(readonly config: ServerConfiguration) {
    this.registry = new RoomRegistry(config.roomsPerIp, config.roomsTotal);
    this.roomListSubscriptions = roomListSubscriptionsCreate(config, this.registry);
    this.connectionsPerIpKey = new LimiterKeyCounter(config.connectionsPerIp);
    this.passwordWorkPerIpKey = new LimiterKeyCounter(config.passwordHashConcurrencyPerIp);
    this.roomEntriesPerIpKey = new LimiterKeyedTokenBucket(
      config.roomEntriesPerIpPerMinute / 60,
      config.roomEntryBurstPerIp,
    );
    this.joinFailuresPerIp = new LimiterFailureWindow(config.joinFailuresPerIpPerMinute, 60_000);
    this.joinFailuresPerRoom = new LimiterFailureWindow(config.joinFailuresPerRoomPerMinute, 60_000);
    this.locksServerBudget = new LimiterSharedBudget(config.locksTotal);
    this.outboundBacklogServerBudget = new LimiterSharedBudget(config.outboundBacklogBytesTotal);
    this.abuseCarry = new LimiterAbuseCarry(config.abuseDecayPerSecond);
    this.pruneTimer = setInterval(() => this.limitersPrune(), 60_000);
    this.leaseTimer = setInterval(() => leasesSweep(this), config.lockLeaseSweepMs);
  }

  /**
   * Reserves a connection slot for an address during the HTTP upgrade.
   *
   * @param ipKey Address limit key.
   * @returns True when the connection may proceed.
   */
  connectionReserve(ipKey: string): boolean {
    if (this.connectionsFull()) return false;
    return this.connectionsPerIpKey.tryAcquire(ipKey);
  }

  /**
   * Whether the relay already has as many sessions as CONNECTIONS_TOTAL allows.
   *
   * @returns True when no further connection fits.
   */
  connectionsFull(): boolean {
    return this.sessions.size >= this.config.connectionsTotal;
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
    this.onlineStats.changed();
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
    this.roomListSubscriptions.unsubscribe(session);
    roomMembershipEnd(this, session, 'disconnected');
    transferSessionClosed(session);
    this.abuseCarry.sessionClosed(session.ipKey, session.limits.abuse);
    session.outbound.clear();
    this.sessions.delete(session.user);
    this.onlineStats.changed();
    this.connectionsPerIpKey.release(session.ipKey);
  }

  /** Closes every connection and stops timers. */
  shutdown(): void {
    clearInterval(this.pruneTimer);
    clearInterval(this.leaseTimer);
    this.onlineStats.stop();
    this.roomListSubscriptions.stop();
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
   * Creates the outbound queue of a newly opened socket.
   *
   * @param socket Transport socket.
   * @param slowConsumer Called when the client cannot keep up.
   * @returns Outbound queue.
   */
  private outboundCreate(socket: CoreSocket, slowConsumer: () => void): ConnectionOutboundQueue {
    return new ConnectionOutboundQueue(
      socket,
      this.config.outboundQueueBytesMaximum,
      this.config.socketBufferHighWaterBytes,
      slowConsumer,
      this.outboundBacklogServerBudget,
    );
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
    const outbound = this.outboundCreate(socket, () => session.close(CLOSE_CODES.slowConsumer, 'slow consumer'));
    session = {
      user: this.userIdNext(),
      clientIp: data.clientIp,
      ipKey: data.ipKey,
      via: data.via,
      outbound,
      close: (code, reason) => socket.close(code, reason),
      ...sessionInitialState(config),
      limits: sessionEditLimits(config, this.abuseCarry.sessionScore(data.ipKey, config.abuseThrottleScore / 2)),
    };
    outbound.idleListener = () => sessionIdle(session);
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
    if (frame[1] === BINARY_FRAME_KIND_TRANSFER_CHUNK) return handlerTransferChunk(this, session, frame);
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
    this.dispatch(session, decoded.message, text.length);
  }

  /**
   * Validates the hello message and replies with welcome.
   *
   * @param session Sender.
   * @param message First message of the connection.
   */
  private handshake(session: ConnectionSession, message: ClientMessage): void {
    if (message.t !== 'hello') return this.violation(session, 'expected hello');
    const negotiated = helloNegotiate(message);
    if (!negotiated.ok) return helloRefuse(session, negotiated.refusal);
    session.protocol = negotiated.protocol;
    session.name = displayNameFromHello(message.name, session.user);
    session.nameChosen = session.name;
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
      version: session.protocol.version,
      versions: { min: PROTOCOL_VERSION_MINIMUM, max: PROTOCOL_VERSION_MAXIMUM },
      caps: [...session.protocol.caps],
      user: session.user,
      name: session.name,
      via: session.via,
      limits: welcomeLimits(this.config),
      ...(session.protocol.caps.has(SERVER_ONLINE_STATS_CAPABILITY) ? { online: this.onlineStats.count() } : {}),
    };
  }

  /**
   * Routes a validated message to its handler.
   *
   * @param session Sender.
   * @param message Validated message.
   * @param bytes Frame size.
   */
  private dispatch(session: ConnectionSession, message: Exclude<ClientMessage, { t: 'hello' }>, bytes: number): void {
    switch (message.t) {
      case 'ping':
        return sessionSend(session, { t: 'pong', ...(message.r === undefined ? {} : { r: message.r }) });
      case 'room.list':
        return handlerRoomList(this, session, message);
      case 'room.subscribe':
        return handlerRoomSubscribe(this, session, message);
      case 'room.unsubscribe':
        return handlerRoomUnsubscribe(this, session, message);
      case 'room.create':
        return void handlerRoomCreate(this, session, message);
      case 'room.join':
        return void handlerRoomJoin(this, session, message);
      case 'room.leave':
        return handlerRoomLeave(this, session, message);
      case 'name.set':
        return handlerNameSet(session, message);
      default:
        return this.dispatchContent(session, message, bytes);
    }
  }

  /**
   * Routes a validated lock, edit, asset or stream message to its handler.
   *
   * @param session Sender.
   * @param message Validated message.
   * @param bytes Frame size.
   */
  private dispatchContent(session: ConnectionSession, message: ContentMessage, bytes: number): void {
    switch (message.t) {
      case 'lock.acquire':
      case 'lock.release':
      case 'edit':
        return verifyHoldOrRun(this, session, message, bytes);
      case 'lock.renew':
        return handlerLockRenew(this, session, message);
      case 'select':
        return handlerSelect(this, session, message);
      case 'typing':
        return handlerTyping(this, session, message);
      case 'verify.result':
        return handlerVerifyResult(this, session, message, bytes);
      default:
        return this.dispatchTransfer(session, message);
    }
  }

  /**
   * Routes a validated chat, asset or stream message to its handler.
   *
   * @param session Sender.
   * @param message Validated message.
   */
  private dispatchTransfer(session: ConnectionSession, message: ContentMessage): void {
    switch (message.t) {
      case 'chat':
        return handlerChat(this, session, message);
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
      case 'transfer.create':
      case 'transfer.info':
      case 'transfer.missing':
        return handlerTransfer(this, session, message);
    }
  }

  /**
   * Routes a lock or edit message that is not held behind an open verify query.
   *
   * @param session Sender.
   * @param message Lock or edit message.
   */
  lockOrEditRoute(session: ConnectionSession, message: ConnectionVerifyHeldMessage): void {
    switch (message.t) {
      case 'lock.acquire':
        return handlerLockAcquire(this, session, message);
      case 'lock.release':
        return handlerLockRelease(this, session, message);
      case 'edit':
        return handlerEdit(this, session, message);
    }
  }

  /** Drops expired failure windows. */
  private limitersPrune(): void {
    this.joinFailuresPerIp.prune();
    this.joinFailuresPerRoom.prune();
    this.roomEntriesPerIpKey.prune();
    this.abuseCarry.prune();
  }
}
