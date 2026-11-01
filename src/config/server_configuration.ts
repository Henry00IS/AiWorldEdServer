/**
 * Server configuration with production defaults, overridable from the
 * environment['']
 */
import {
  CHAT_SEND_INTERVAL_MS,
  CHAT_TEXT_LENGTH_MAXIMUM,
  CHAT_TEXT_LINES_MAXIMUM,
} from '../shared/chat_text_policy.ts';
import { LOCK_LEASE_MS, PROTOCOL_WEBSOCKET_PATH } from '../shared/protocol_definitions.ts';

/** Every tunable limit and setting of the relay. */
export interface ServerConfiguration {
  hostname: string;
  port: number;
  websocketPath: string;
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
  roomsPerIp: number;
  roomsTotal: number;
  usersPerRoomDefault: number;
  usersPerRoomMaximum: number;
  locksPerUser: number;
  locksPerRoom: number;
  locksTotal: number;
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
  /** Abuse score points that decay per second. */
  abuseDecayPerSecond: number;
  /** Abuse score at which lock, edit and select messages are refused. */
  abuseThrottleScore: number;
  /** Abuse score at which the connection is closed with code 4007. */
  abuseDisconnectScore: number;
  /** How long an address may not rejoin the room it was closed for abuse in. */
  abuseRoomCooldownMs: number;
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
} satisfies Partial<ServerConfiguration>;

/** Default room, lock, stream, join and presence limits. */
const CONFIGURATION_ROOM_LIMITS_DEFAULT = {
  roomsPerIp: 8,
  roomsTotal: 500,
  usersPerRoomDefault: 16,
  usersPerRoomMaximum: 32,
  locksPerUser: 20_000,
  locksPerRoom: 100_000,
  locksTotal: 400_000,
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
  abuseDecayPerSecond: 1,
  abuseThrottleScore: 20,
  abuseDisconnectScore: 60,
  abuseRoomCooldownMs: 60_000,
} satisfies Partial<ServerConfiguration>;

/**
 * Builds the default configuration.
 *
 * @returns Configuration with production defaults and no forwarded secret.
 */
export function configurationDefault(): ServerConfiguration {
  return {
    hostname: '0.0.0.0',
    port: 8081,
    websocketPath: PROTOCOL_WEBSOCKET_PATH,
    forwardedSecret: null,
    allowedOrigins: [...ALLOWED_ORIGINS_DEFAULT],
    internalTestRoomsEnabled: true,
    internalTestRoomsViaProxy: false,
    ...CONFIGURATION_CONNECTION_LIMITS_DEFAULT,
    ...CONFIGURATION_ROOM_LIMITS_DEFAULT,
    ...CONFIGURATION_EDIT_LIMITS_DEFAULT,
  };
}

/**
 * Builds the configuration from environment variables on top of the defaults.
 *
 * @param environment Environment variable map.
 * @returns Effective configuration.
 */
export function configurationFromEnvironment(environment: Record<string, string | undefined>): ServerConfiguration {
  const configuration = configurationDefault();
  configuration.hostname = environment['HOST'] ?? configuration.hostname;
  configuration.port = configurationParsePort(environment['PORT'], configuration.port);
  configuration.websocketPath = configurationParsePath(environment['WEBSOCKET_PATH'], configuration.websocketPath);
  configuration.forwardedSecret = configurationParseSecret(environment['FORWARDED_SECRET']);
  configuration.internalTestRoomsEnabled = environment['INTERNAL_TEST_ROOMS'] !== 'false';
  configuration.internalTestRoomsViaProxy = environment['INTERNAL_TEST_ROOMS_VIA_PROXY'] === 'true';
  if (environment['ALLOWED_ORIGINS'])
    configuration.allowedOrigins = configurationParseList(environment['ALLOWED_ORIGINS']);
  configurationApplyPerIpLimits(configuration, environment);
  return configuration;
}

/**
 * Optional per-IP limit overrides and the configuration field each one sets.
 * Meant for the development relay, where every test client shares one address;
 * production leaves them unset.
 */
const CONFIGURATION_PER_IP_LIMIT_VARIABLES = [
  ['CONNECTIONS_PER_IP', 'connectionsPerIp'],
  ['ROOMS_PER_IP', 'roomsPerIp'],
  ['ROOM_ENTRIES_PER_IP_PER_MINUTE', 'roomEntriesPerIpPerMinute'],
  ['ROOM_ENTRY_BURST_PER_IP', 'roomEntryBurstPerIp'],
] as const;

/**
 * Applies the optional per-IP limit overrides listed in
 * CONFIGURATION_PER_IP_LIMIT_VARIABLES.
 *
 * @param configuration Configuration to update.
 * @param environment Environment variable map.
 */
function configurationApplyPerIpLimits(
  configuration: ServerConfiguration,
  environment: Record<string, string | undefined>,
): void {
  for (const [variableName, field] of CONFIGURATION_PER_IP_LIMIT_VARIABLES)
    configuration[field] = configurationParseLimit(variableName, environment[variableName], configuration[field]);
}

/**
 * Parses a positive integer limit from an environment value.
 *
 * @param variableName Environment variable name, used in the error message.
 * @param value Raw value.
 * @param fallback Limit used when unset.
 * @returns Limit between 1 and 100000.
 */
function configurationParseLimit(variableName: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000)
    throw new Error(`${variableName} must be an integer between 1 and 100000`);
  return limit;
}

/**
 * Parses a TCP port from an environment value.
 *
 * @param value Raw port string.
 * @param fallback Port used when unset.
 * @returns Valid TCP port.
 */
function configurationParsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be an integer between 0 and 65535');
  return port;
}

/**
 * Parses the WebSocket path from an environment value. The dev relay uses
 * `/wstest` because the proxy forwards that path unchanged.
 *
 * @param value Raw path.
 * @param fallback Path used when unset.
 * @returns Path starting with a slash.
 */
function configurationParsePath(value: string | undefined, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  if (!/^\/[A-Za-z0-9_\-/]{1,63}$/.test(value)) throw new Error('WEBSOCKET_PATH must look like /ws or /wstest');
  return value;
}

/**
 * Parses the shared proxy secret from an environment value.
 *
 * @param value Raw secret.
 * @returns The secret, or null when unset. Rejects secrets shorter than 16
 *   characters.
 */
function configurationParseSecret(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (value.length < 16) throw new Error('FORWARDED_SECRET must be at least 16 characters');
  return value;
}

/**
 * Splits a comma separated environment value into entries.
 *
 * @param value Comma separated list.
 * @returns Trimmed non-empty entries.
 */
function configurationParseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
