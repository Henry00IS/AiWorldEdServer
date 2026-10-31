/**
 * Server configuration with production defaults, overridable from the environment.
 */

/** Every tunable limit and setting of the relay. */
export interface ServerConfiguration {
  hostname: string;
  port: number;
  forwardedSecret: string | null;
  allowedOrigins: string[];
  internalTestRoomsEnabled: boolean;
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
  outboundQueueBytesMaximum: number;
  socketBufferHighWaterBytes: number;
  snapshotBytesMaximum: number;
  assetBytesMaximum: number;
  streamWindowBytes: number;
  streamsPerRecipient: number;
  snapshotTimeoutMs: number;
  joinFailuresPerIpPerMinute: number;
  joinFailuresPerRoomPerMinute: number;
  passwordHashConcurrency: number;
  roomListMaximum: number;
  presencePerSecond: number;
  presenceBurst: number;
  presenceHighWaterBytes: number;
}

/** Default Origin allow list: GitHub Pages, local dev servers and the desktop app. */
export const ALLOWED_ORIGINS_DEFAULT = [
  'https://henry00is.github.io',
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
  'views://main_ui',
];

/**
 * Builds the default configuration.
 *
 * @returns Configuration with production defaults and no forwarded secret.
 */
export function configurationDefault(): ServerConfiguration {
  return {
    hostname: '0.0.0.0',
    port: 8081,
    forwardedSecret: null,
    allowedOrigins: [...ALLOWED_ORIGINS_DEFAULT],
    internalTestRoomsEnabled: true,
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
    roomsPerIp: 8,
    roomsTotal: 500,
    usersPerRoomDefault: 16,
    usersPerRoomMaximum: 32,
    locksPerUser: 20_000,
    locksPerRoom: 100_000,
    outboundQueueBytesMaximum: 16 * 1024 * 1024,
    socketBufferHighWaterBytes: 1024 * 1024,
    snapshotBytesMaximum: 256 * 1024 * 1024,
    assetBytesMaximum: 64 * 1024 * 1024,
    streamWindowBytes: 4 * 1024 * 1024,
    streamsPerRecipient: 8,
    snapshotTimeoutMs: 60_000,
    joinFailuresPerIpPerMinute: 10,
    joinFailuresPerRoomPerMinute: 30,
    passwordHashConcurrency: 4,
    roomListMaximum: 200,
    presencePerSecond: 10,
    presenceBurst: 20,
    presenceHighWaterBytes: 64 * 1024,
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
  configuration.hostname = environment.HOST ?? configuration.hostname;
  configuration.port = configurationParsePort(environment.PORT, configuration.port);
  configuration.forwardedSecret = configurationParseSecret(environment.FORWARDED_SECRET);
  configuration.internalTestRoomsEnabled = environment.INTERNAL_TEST_ROOMS !== 'false';
  if (environment.ALLOWED_ORIGINS) configuration.allowedOrigins = configurationParseList(environment.ALLOWED_ORIGINS);
  return configuration;
}

/**
 * @param value Raw port string.
 * @param fallback Port used when unset.
 * @returns Valid TCP port.
 */
function configurationParsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  return port;
}

/**
 * @param value Raw secret.
 * @returns The secret, or null when unset. Rejects secrets shorter than 16 characters.
 */
function configurationParseSecret(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (value.length < 16) throw new Error('FORWARDED_SECRET must be at least 16 characters');
  return value;
}

/**
 * @param value Comma separated list.
 * @returns Trimmed non-empty entries.
 */
function configurationParseList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
