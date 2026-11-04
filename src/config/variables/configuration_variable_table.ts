/**
 * Every setting a self-hoster may change, with its validation. The same names
 * work as environment variables and as keys of the optional JSON config file.
 */
import type { ConfigurationVariable } from './configuration_variable.ts';
import { ConfigurationVariableBoolean } from './configuration_variable_boolean.ts';
import { ConfigurationVariableInteger } from './configuration_variable_integer.ts';
import { ConfigurationVariableList } from './configuration_variable_list.ts';
import { ConfigurationVariableOptionalText } from './configuration_variable_optional_text.ts';
import { ConfigurationVariableText } from './configuration_variable_text.ts';

/** One mebibyte. */
const MEBIBYTE = 1024 * 1024;
/**
 * Largest stream the protocol schema accepts; snapshot and asset limits may not
 * exceed it.
 */
const CONFIGURATION_STREAM_BYTES_CEILING = 512 * MEBIBYTE;
/**
 * Allowed Origin entry: `*`, or `scheme://host` with an optional `:port` or
 * `:*`.
 */
const CONFIGURATION_ORIGIN_ENTRY_PATTERN =
  /^(\*|[a-z][a-z0-9+.-]*:\/\/(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(:(\d{1,5}|\*))?)$/i;

/** Listener, TLS and proxy settings. */
const CONFIGURATION_VARIABLES_NETWORK: readonly ConfigurationVariable[] = [
  new ConfigurationVariableText(
    'HOST',
    'network',
    'hostname',
    /^[A-Za-z0-9_.:-]{1,253}$/,
    'an IP address or host name',
    'Address to listen on; 0.0.0.0 for all IPv4 interfaces, :: for all interfaces.',
  ),
  new ConfigurationVariableInteger('PORT', 'network', 'port', 0, 65535, 'TCP port to listen on (0 picks a free port).'),
  new ConfigurationVariableText(
    'WEBSOCKET_PATH',
    'network',
    'websocketPath',
    /^\/[A-Za-z0-9_\-/]{1,63}$/,
    'a path like /ws or /wstest',
    'URL path of the WebSocket endpoint.',
  ),
  new ConfigurationVariableOptionalText(
    'TLS_CERT',
    'network',
    'tlsCertificateFile',
    1,
    false,
    'PEM certificate (full chain) file; with TLS_KEY the relay serves wss:// itself.',
  ),
  new ConfigurationVariableOptionalText(
    'TLS_KEY',
    'network',
    'tlsKeyFile',
    1,
    false,
    'PEM private key file for TLS_CERT.',
  ),
  new ConfigurationVariableBoolean(
    'TRUST_PROXY',
    'network',
    'trustProxy',
    'Take the client address from X-Real-IP / X-Forwarded-For. Only behind a reverse proxy.',
  ),
  new ConfigurationVariableOptionalText(
    'FORWARDED_SECRET',
    'network',
    'forwardedSecret',
    16,
    true,
    'Optional with TRUST_PROXY: requests with a different X-Forwarded-Secret are refused.',
  ),
];

/** Origin allow list. */
const CONFIGURATION_VARIABLES_SECURITY: readonly ConfigurationVariable[] = [
  new ConfigurationVariableList(
    'ALLOWED_ORIGINS',
    'security',
    'allowedOrigins',
    CONFIGURATION_ORIGIN_ENTRY_PATTERN,
    'origins (`https://host`, `http://host:*` for any port, or `*` for any)',
    "Web pages allowed to connect (the editor's address); replaces the default list.",
  ),
];

/** Room capacity settings. */
const CONFIGURATION_VARIABLES_ROOMS: readonly ConfigurationVariable[] = [
  new ConfigurationVariableInteger(
    'USERS_PER_ROOM_DEFAULT',
    'rooms',
    'usersPerRoomDefault',
    2,
    1000,
    'Room size when the creator does not choose one.',
  ),
  new ConfigurationVariableInteger(
    'USERS_PER_ROOM_MAX',
    'rooms',
    'usersPerRoomMaximum',
    2,
    1000,
    'Largest room size a creator may choose.',
  ),
  new ConfigurationVariableInteger(
    'ROOMS_TOTAL',
    'rooms',
    'roomsTotal',
    1,
    100_000,
    'Rooms open at once on the whole relay.',
  ),
  new ConfigurationVariableInteger(
    'ROOMS_PER_IP',
    'rooms',
    'roomsPerIp',
    1,
    100_000,
    'Rooms one address (IPv6: one /64) may own at once.',
  ),
  new ConfigurationVariableInteger(
    'LOCKS_PER_USER',
    'rooms',
    'locksPerUser',
    1,
    10_000_000,
    'Objects one member may hold locked at once.',
  ),
  new ConfigurationVariableInteger(
    'LOCKS_PER_ROOM',
    'rooms',
    'locksPerRoom',
    1,
    10_000_000,
    'Objects locked at once in one room.',
  ),
  new ConfigurationVariableInteger(
    'LOCKS_TOTAL',
    'rooms',
    'locksTotal',
    1,
    10_000_000,
    'Objects locked at once on the whole relay.',
  ),
  new ConfigurationVariableInteger(
    'SNAPSHOT_BYTES_MAX',
    'rooms',
    'snapshotBytesMaximum',
    MEBIBYTE,
    CONFIGURATION_STREAM_BYTES_CEILING,
    'Largest world snapshot sent to a joining member, in bytes.',
  ),
  new ConfigurationVariableInteger(
    'ASSET_BYTES_MAX',
    'rooms',
    'assetBytesMaximum',
    MEBIBYTE,
    CONFIGURATION_STREAM_BYTES_CEILING,
    'Largest single asset (texture) transfer, in bytes.',
  ),
  new ConfigurationVariableInteger(
    'SNAPSHOT_TIMEOUT_MS',
    'rooms',
    'snapshotTimeoutMs',
    5000,
    3_600_000,
    "How long a joining member waits for the owner's snapshot.",
  ),
];

/** Connection and memory limits. */
const CONFIGURATION_VARIABLES_LIMITS: readonly ConfigurationVariable[] = [
  new ConfigurationVariableInteger(
    'CONNECTIONS_TOTAL',
    'limits',
    'connectionsTotal',
    1,
    100_000,
    'Open connections on the whole relay.',
  ),
  new ConfigurationVariableInteger(
    'CONNECTIONS_PER_IP',
    'limits',
    'connectionsPerIp',
    1,
    100_000,
    'Open connections from one address (IPv6: one /64).',
  ),
  new ConfigurationVariableInteger(
    'ROOM_ENTRIES_PER_IP_PER_MINUTE',
    'limits',
    'roomEntriesPerIpPerMinute',
    1,
    100_000,
    'Room creations and joins per address per minute.',
  ),
  new ConfigurationVariableInteger(
    'ROOM_ENTRY_BURST_PER_IP',
    'limits',
    'roomEntryBurstPerIp',
    1,
    100_000,
    'Room creations and joins one address may make in a burst.',
  ),
  new ConfigurationVariableInteger(
    'MAX_PAYLOAD_BYTES',
    'limits',
    'maxPayloadBytes',
    512 * 1024,
    64 * MEBIBYTE,
    'Largest single WebSocket message, in bytes.',
  ),
  new ConfigurationVariableInteger(
    'OUTBOUND_BACKLOG_BYTES_TOTAL',
    'limits',
    'outboundBacklogBytesTotal',
    16 * MEBIBYTE,
    64 * 1024 * MEBIBYTE,
    'Bytes queued for slow receivers on the whole relay; caps memory use.',
  ),
  new ConfigurationVariableInteger(
    'TRANSFER_SIZE_MAXIMUM',
    'limits',
    'transferSizeMaximum',
    0,
    100 * MEBIBYTE,
    'Largest file a transfer link serves, in bytes (at most 100 MiB).',
  ),
  new ConfigurationVariableInteger(
    'TRANSFER_DOWNLOADS_PER_OWNER',
    'limits',
    'transferDownloadsPerOwner',
    1,
    1000,
    'Concurrent downloads of the transfer links of one connection.',
  ),
];

/** Development switches. */
const CONFIGURATION_VARIABLES_TESTING: readonly ConfigurationVariable[] = [
  new ConfigurationVariableBoolean(
    'INTERNAL_TEST_ROOMS',
    'testing',
    'internalTestRoomsEnabled',
    'Allow hidden internal test rooms for direct (non-proxied) connections. Development only.',
  ),
  new ConfigurationVariableBoolean(
    'INTERNAL_TEST_ROOMS_VIA_PROXY',
    'testing',
    'internalTestRoomsViaProxy',
    'Also allow internal test rooms through the proxy. Development relay only.',
  ),
];

/** Every setting, in documentation order. */
export const CONFIGURATION_VARIABLES: readonly ConfigurationVariable[] = [
  ...CONFIGURATION_VARIABLES_NETWORK,
  ...CONFIGURATION_VARIABLES_SECURITY,
  ...CONFIGURATION_VARIABLES_ROOMS,
  ...CONFIGURATION_VARIABLES_LIMITS,
  ...CONFIGURATION_VARIABLES_TESTING,
];

/** Settings by name. */
export const CONFIGURATION_VARIABLES_BY_NAME: ReadonlyMap<string, ConfigurationVariable> = new Map(
  CONFIGURATION_VARIABLES.map((variable) => [variable.name, variable]),
);
