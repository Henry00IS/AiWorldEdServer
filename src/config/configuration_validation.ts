/** Checks between settings that are only valid together. */
import type { ServerConfiguration } from './server_configuration.ts';

/** One rule between settings and the message shown when it is broken. */
interface ConfigurationRule {
  readonly holds: (configuration: ServerConfiguration) => boolean;
  readonly message: string;
}

/** Every rule a loaded configuration must satisfy. */
const CONFIGURATION_RULES: readonly ConfigurationRule[] = [
  {
    holds: (configuration) => (configuration.tlsCertificateFile === null) === (configuration.tlsKeyFile === null),
    message: 'TLS_CERT and TLS_KEY must be set together',
  },
  {
    holds: (configuration) => configuration.forwardedSecret === null || configuration.trustProxy,
    message: 'FORWARDED_SECRET only works with TRUST_PROXY=true (set both, or remove FORWARDED_SECRET)',
  },
  {
    holds: (configuration) => !configuration.internalTestRoomsViaProxy || configuration.internalTestRoomsEnabled,
    message: 'INTERNAL_TEST_ROOMS_VIA_PROXY=true needs INTERNAL_TEST_ROOMS=true',
  },
  {
    holds: (configuration) => configuration.usersPerRoomDefault <= configuration.usersPerRoomMaximum,
    message: 'USERS_PER_ROOM_DEFAULT must not exceed USERS_PER_ROOM_MAX',
  },
  {
    holds: (configuration) => configuration.connectionsPerIp <= configuration.connectionsTotal,
    message: 'CONNECTIONS_PER_IP must not exceed CONNECTIONS_TOTAL',
  },
  {
    holds: (configuration) => configuration.roomsPerIp <= configuration.roomsTotal,
    message: 'ROOMS_PER_IP must not exceed ROOMS_TOTAL',
  },
  {
    holds: (configuration) => configuration.locksPerUser <= configuration.locksPerRoom,
    message: 'locks must satisfy LOCKS_PER_USER <= LOCKS_PER_ROOM',
  },
  {
    holds: (configuration) => configuration.maxPayloadBytes >= configuration.streamChunkBytesMaximum * 2,
    message: 'MAX_PAYLOAD_BYTES must be at least twice the stream chunk size (512 KiB)',
  },
];

/**
 * Throws for the first broken rule between settings.
 *
 * @param configuration Configuration after every setting was applied.
 */
export function configurationValidate(configuration: ServerConfiguration): void {
  const brokenRule = CONFIGURATION_RULES.find((rule) => !rule.holds(configuration));
  if (brokenRule) throw new Error(brokenRule.message);
}
