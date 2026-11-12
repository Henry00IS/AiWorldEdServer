/**
 * Server configuration and its production defaults. The environment and the
 * optional config file override them through `configuration_load.ts`.
 */
import {
  CHAT_SEND_INTERVAL_MS,
  CHAT_TEXT_LENGTH_MAXIMUM,
  CHAT_TEXT_LINES_MAXIMUM,
} from '../shared/chat_text_policy.ts';
import {
  LOCK_LEASE_MS,
  PROTOCOL_WEBSOCKET_PATH,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_CREATE_INTERVAL_MS,
  TRANSFER_LINK_LIFETIME_MS,
  TRANSFER_SIZE_MAXIMUM,
} from '../shared/protocol_definitions.ts';

/** Every tunable limit and setting of the relay. */
export interface ServerConfiguration {
  /** Maximum time to wait for owner compatibility approval. */
  compatibilityTimeoutMs: number;
  /** Maximum pending compatibility checks in one room. */
  compatibilityPendingPerRoom: number;
  /** Maximum custom payload bytes in any sliding second per sender. */
  customBytesPerSecond: number;
  /** Maximum custom frames in any sliding second per sender. */
  customMessagesPerSecond: number;
  hostname: string;
  port: number;
  websocketPath: string;
  /**
   * PEM certificate file served for wss://, or null for plain ws:// (TLS at a
   * proxy or none).
   */
  tlsCertificateFile: string | null;
  /** PEM private key file for the certificate, or null. */
  tlsKeyFile: string | null;
  /**
   * Whether forwarded client address headers are trusted (only behind a reverse
   * proxy).
   */
  trustProxy: boolean;
  /**
   * Secret a trusted proxy must send in X-Forwarded-Secret, or null to not
   * require one.
   */
  forwardedSecret: string | null;
  allowedOrigins: string[];
  internalTestRoomsEnabled: boolean;
  internalTestRoomsViaProxy: boolean;
  maxPayloadBytes: number;
  streamChunkBytesMaximum: number;
  handshakeTimeoutMs: number;
  idleTimeoutSeconds: number;
  messagesPerSecond: number;
  messageBurst: number;
  bytesPerSecond: number;
  byteBurst: number;
  connectionsPerIp: number;
  connectionsTotal: number;
  /**
   * Refused upgrades kept open at once just long enough to tell the client why
   * (close code plus reason); beyond this they get a plain HTTP error.
   */
  refusedSocketsMaximum: number;
  roomsPerIp: number;
  roomsTotal: number;
  usersPerRoomDefault: number;
  usersPerRoomMaximum: number;
  locksPerUser: number;
  locksPerRoom: number;
  outboundQueueBytesMaximum: number;
  outboundBacklogBytesTotal: number;
  socketBufferHighWaterBytes: number;
  snapshotBytesMaximum: number;
  assetBytesMaximum: number;
  streamWindowBytes: number;
  streamsPerRecipient: number;
  snapshotTimeoutMs: number;
  joinFailuresPerIpPerMinute: number;
  joinFailuresPerRoomPerMinute: number;
  passwordHashConcurrency: number;
  passwordHashConcurrencyPerIp: number;
  roomEntriesPerIpPerMinute: number;
  roomEntryBurstPerIp: number;
  roomListMaximum: number;
  roomListSubscribersMaximum: number;
  roomListPushIntervalMs: number;
  presencePerSecond: number;
  presenceBurst: number;
  presenceHighWaterBytes: number;
  /** Toy snapshot frames one member may send per second. */
  toysPerSecond: number;
  /** Burst of toy snapshot frames of one member. */
  toysBurst: number;
  /** Minimum time between two chat messages of one session. */
  chatIntervalMs: number;
  /** Maximum chat message length in code points (at most the protocol cap). */
  chatTextLengthMaximum: number;
  /** Maximum lines per chat message (at most the protocol cap). */
  chatTextLinesMaximum: number;
  /**
   * Chat messages held per recipient while edits and streams go first; the
   * oldest is dropped when a slow recipient falls further behind.
   */
  chatPendingPerRecipient: number;
  /**
   * How long the relay waits for the room owner to confirm a member's claimed
   * ancestors before it refuses the request.
   */
  verifyTimeoutMs: number;
  /** Owner queries one member may cause per second. */
  verifyPerMemberPerSecond: number;
  /** Burst of owner queries one member may cause. */
  verifyPerMemberBurst: number;
  /** Owner queries one room may send per second, all members together. */
  verifyPerRoomPerSecond: number;
  /** Burst of owner queries one room may send. */
  verifyPerRoomBurst: number;
  /**
   * Lock and edit messages held per member while its query is open; more closes
   * the connection as rate limited.
   */
  verifyQueueMessagesMaximum: number;
  /** Bytes of lock and edit messages held per member while its query is open. */
  verifyQueueBytesMaximum: number;
  /** Edit lease lifetime without a renewal or an edit (relay monotonic clock). */
  lockLeaseMs: number;
  /** Longest a lease may live on renewals alone, without any accepted edit. */
  lockLeaseIdleMaximumMs: number;
  /** Longest one lease (one operation) may live at all. */
  lockLeaseTotalMaximumMs: number;
  /** How often the relay sweeps for expired leases. */
  lockLeaseSweepMs: number;
  /** New leases (operations) one member may start per second. */
  leasesPerSecond: number;
  /** Burst of new leases one member may start. */
  leaseBurst: number;
  /** Lease renewals one member may send per second. */
  leaseRenewsPerSecond: number;
  /** Burst of lease renewals of one member. */
  leaseRenewBurst: number;
  /** One-shot edit messages one member may send per second. */
  oneShotEditsPerSecond: number;
  /** Burst of one-shot edit messages of one member. */
  oneShotEditBurst: number;
  /** One-shot edit messages a whole room may send per second. */
  oneShotEditsPerRoomPerSecond: number;
  /** Burst of one-shot edit messages of a whole room. */
  oneShotEditRoomBurst: number;
  /** Live preview edit messages one member may send per second. */
  liveEditsPerSecond: number;
  /** Burst of live preview edit messages of one member. */
  liveEditBurst: number;
  /** Created plus deleted ids one member may send per second. */
  bulkIdsPerSecond: number;
  /** Burst of created plus deleted ids of one member. */
  bulkIdBurst: number;
  /** Selection presence messages one member may send per second. */
  selectsPerSecond: number;
  /** Burst of selection presence messages of one member. */
  selectBurst: number;
  /** How long a typing flag stays set without another signal (ms). */
  typingExpiryMs: number;
  /** Abuse score points that decay per second. */
  abuseDecayPerSecond: number;
  /** Abuse score at which lock, edit and select messages are refused. */
  abuseThrottleScore: number;
  /** Abuse score at which the connection is closed with code 4007. */
  abuseDisconnectScore: number;
  /** How long an address may not rejoin the room it was closed for abuse in. */
  abuseRoomCooldownMs: number;
  /** How long a transfer link works at most; it also dies with its connection. */
  transferLinkLifetimeMs: number;
  /** Minimum time between two transfer links of one connection. */
  transferCreateIntervalMs: number;
  /** Largest file a transfer link serves; larger files get 413. */
  transferSizeMaximum: number;
  /** Bytes the relay asks the link owner for per chunk (one chunk in flight). */
  transferChunkBytes: number;
  /** Concurrent downloads of one owner connection; more get 503. */
  transferDownloadsPerOwner: number;
  /** How long the relay waits for the owner's file info or next chunk. */
  transferReplyTimeoutMs: number;
}

/**
 * Default Origin allow list: GitHub Pages, local dev servers and the desktop
 * app.
 */
export const ALLOWED_ORIGINS_DEFAULT = [
  'https://henry00is.github.io',
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
  'views://main_ui',
];

/** Default per-connection and server-wide traffic limits. */
const CONFIGURATION_CONNECTION_LIMITS_DEFAULT = {
  maxPayloadBytes: 1024 * 1024,
  streamChunkBytesMaximum: 256 * 1024,
  handshakeTimeoutMs: 5000,
  idleTimeoutSeconds: 60,
  messagesPerSecond: 120,
  messageBurst: 400,
  bytesPerSecond: 16 * 1024 * 1024,
  byteBurst: 32 * 1024 * 1024,
  connectionsPerIp: 24,
  connectionsTotal: 2000,
  refusedSocketsMaximum: 256,
} satisfies Partial<ServerConfiguration>;

/** Default room, lock, stream, join and presence limits. */
const CONFIGURATION_ROOM_LIMITS_DEFAULT = {
  roomsPerIp: 8,
  roomsTotal: 500,
  usersPerRoomDefault: 16,
  usersPerRoomMaximum: 32,
  locksPerUser: 20_000,
  locksPerRoom: 100_000,
  outboundQueueBytesMaximum: 16 * 1024 * 1024,
  outboundBacklogBytesTotal: 256 * 1024 * 1024,
  socketBufferHighWaterBytes: 1024 * 1024,
  snapshotBytesMaximum: 256 * 1024 * 1024,
  assetBytesMaximum: 64 * 1024 * 1024,
  streamWindowBytes: 4 * 1024 * 1024,
  streamsPerRecipient: 8,
  snapshotTimeoutMs: 60_000,
  joinFailuresPerIpPerMinute: 10,
  joinFailuresPerRoomPerMinute: 30,
  passwordHashConcurrency: 4,
  passwordHashConcurrencyPerIp: 1,
  roomEntriesPerIpPerMinute: 30,
  roomEntryBurstPerIp: 10,
  roomListMaximum: 200,
  roomListSubscribersMaximum: 1000,
  roomListPushIntervalMs: 500,
  presencePerSecond: 10,
  presenceBurst: 20,
  presenceHighWaterBytes: 64 * 1024,
  toysPerSecond: 5,
  toysBurst: 10,
  chatIntervalMs: CHAT_SEND_INTERVAL_MS,
  chatTextLengthMaximum: CHAT_TEXT_LENGTH_MAXIMUM,
  chatTextLinesMaximum: CHAT_TEXT_LINES_MAXIMUM,
  chatPendingPerRecipient: 64,
  verifyTimeoutMs: 5000,
  verifyPerMemberPerSecond: 10,
  verifyPerMemberBurst: 20,
  verifyPerRoomPerSecond: 50,
  verifyPerRoomBurst: 100,
  verifyQueueMessagesMaximum: 64,
  verifyQueueBytesMaximum: 4 * 1024 * 1024,
} satisfies Partial<ServerConfiguration>;

/**
 * Default edit lease, edit rate and abuse limits. Tuned against real tool
 * timings: a drag streams 30 previews per second and renews every 1.5 s, the
 * editor commits at most every 250 ms plus once per command, and an undo key
 * held down is sent one step at a time.
 */
const CONFIGURATION_EDIT_LIMITS_DEFAULT = {
  lockLeaseMs: LOCK_LEASE_MS,
  lockLeaseIdleMaximumMs: 60_000,
  lockLeaseTotalMaximumMs: 600_000,
  lockLeaseSweepMs: 500,
  leasesPerSecond: 10,
  leaseBurst: 20,
  leaseRenewsPerSecond: 4,
  leaseRenewBurst: 8,
  oneShotEditsPerSecond: 20,
  oneShotEditBurst: 60,
  oneShotEditsPerRoomPerSecond: 200,
  oneShotEditRoomBurst: 400,
  liveEditsPerSecond: 60,
  liveEditBurst: 120,
  bulkIdsPerSecond: 10_000,
  bulkIdBurst: 250_000,
  selectsPerSecond: 10,
  selectBurst: 20,
  typingExpiryMs: 10_000,
  abuseDecayPerSecond: 1,
  abuseThrottleScore: 20,
  abuseDisconnectScore: 60,
  abuseRoomCooldownMs: 60_000,
} satisfies Partial<ServerConfiguration>;

const CONFIGURATION_TRANSFER_LIMITS_DEFAULT = {
  transferLinkLifetimeMs: TRANSFER_LINK_LIFETIME_MS,
  transferCreateIntervalMs: TRANSFER_CREATE_INTERVAL_MS,
  transferSizeMaximum: TRANSFER_SIZE_MAXIMUM,
  transferChunkBytes: TRANSFER_CHUNK_BYTES,
  transferDownloadsPerOwner: 16,
  transferReplyTimeoutMs: 20_000,
} satisfies Partial<ServerConfiguration>;

/** Default fork admission and custom channel limits. */
const CONFIGURATION_FORK_LIMITS_DEFAULT = {
  compatibilityTimeoutMs: 5000,
  compatibilityPendingPerRoom: 32,
  customBytesPerSecond: 256 * 1024,
  customMessagesPerSecond: 4096,
} satisfies Partial<ServerConfiguration>;

/**
 * Builds the default configuration.
 *
 * @returns Configuration with production defaults: direct connections, no TLS,
 *   no internal test rooms.
 */
export function configurationDefault(): ServerConfiguration {
  return {
    ...CONFIGURATION_FORK_LIMITS_DEFAULT,
    hostname: '0.0.0.0',
    port: 8081,
    websocketPath: PROTOCOL_WEBSOCKET_PATH,
    tlsCertificateFile: null,
    tlsKeyFile: null,
    trustProxy: false,
    forwardedSecret: null,
    allowedOrigins: [...ALLOWED_ORIGINS_DEFAULT],
    internalTestRoomsEnabled: false,
    internalTestRoomsViaProxy: false,
    ...CONFIGURATION_CONNECTION_LIMITS_DEFAULT,
    ...CONFIGURATION_ROOM_LIMITS_DEFAULT,
    ...CONFIGURATION_EDIT_LIMITS_DEFAULT,
    ...CONFIGURATION_TRANSFER_LIMITS_DEFAULT,
  };
}
