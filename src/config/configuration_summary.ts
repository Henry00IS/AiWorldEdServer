/** Structured startup summary and warnings about risky settings. */
import { PROTOCOL_VERSION } from '../shared/protocol_definitions.ts';
import type { ServerConfiguration } from './server_configuration.ts';

/** Startup summary printed as one JSON line. */
export interface ConfigurationSummary {
  readonly event: 'relay.started';
  readonly protocol: number;
  readonly url: string;
  readonly tls: boolean;
  readonly clientAddress: 'socket' | 'forwarded headers';
  readonly forwardedSecret: 'required' | 'not required' | 'unused';
  readonly allowedOrigins: readonly string[];
  readonly internalTestRooms: 'off' | 'direct only' | 'direct and proxied';
  readonly limits: Readonly<Record<string, number>>;
  readonly configFile: string | null;
}

/**
 * Formats a host for a URL, bracketing IPv6 addresses.
 *
 * @param hostname Listen address.
 * @returns Host part of a URL.
 */
function configurationSummaryHost(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/**
 * Describes when internal test rooms are available.
 *
 * @param configuration Effective configuration.
 * @returns Availability text.
 */
function configurationSummaryInternalTestRooms(
  configuration: ServerConfiguration,
): ConfigurationSummary['internalTestRooms'] {
  if (!configuration.internalTestRoomsEnabled) return 'off';
  return configuration.internalTestRoomsViaProxy ? 'direct and proxied' : 'direct only';
}

/**
 * Describes whether a forwarded secret is checked.
 *
 * @param configuration Effective configuration.
 * @returns Secret status; the secret itself is never included.
 */
function configurationSummaryForwardedSecret(
  configuration: ServerConfiguration,
): ConfigurationSummary['forwardedSecret'] {
  if (!configuration.trustProxy) return 'unused';
  return configuration.forwardedSecret === null ? 'not required' : 'required';
}

/**
 * Builds the startup summary.
 *
 * @param configuration Effective configuration.
 * @param boundPort Port the relay actually listens on.
 * @param configFile Config file that was read, or null.
 * @returns Summary without any secret.
 */
export function configurationSummary(
  configuration: ServerConfiguration,
  boundPort: number,
  configFile: string | null,
): ConfigurationSummary {
  const tls = configuration.tlsCertificateFile !== null;
  return {
    event: 'relay.started',
    protocol: PROTOCOL_VERSION,
    url: `${tls ? 'wss' : 'ws'}://${configurationSummaryHost(configuration.hostname)}:${boundPort}${configuration.websocketPath}`,
    tls,
    clientAddress: configuration.trustProxy ? 'forwarded headers' : 'socket',
    forwardedSecret: configurationSummaryForwardedSecret(configuration),
    allowedOrigins: configuration.allowedOrigins,
    internalTestRooms: configurationSummaryInternalTestRooms(configuration),
    limits: configurationSummaryLimits(configuration),
    configFile,
  };
}

/**
 * Picks the limits a self-hoster most often tunes.
 *
 * @param configuration Effective configuration.
 * @returns Limits by name.
 */
function configurationSummaryLimits(configuration: ServerConfiguration): Record<string, number> {
  return {
    usersPerRoomDefault: configuration.usersPerRoomDefault,
    usersPerRoomMaximum: configuration.usersPerRoomMaximum,
    roomsTotal: configuration.roomsTotal,
    roomsPerIp: configuration.roomsPerIp,
    connectionsTotal: configuration.connectionsTotal,
    connectionsPerIp: configuration.connectionsPerIp,
    snapshotBytesMaximum: configuration.snapshotBytesMaximum,
  };
}

/** Listen addresses that accept connections from every interface. */
const CONFIGURATION_HOSTS_ALL_INTERFACES = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Lists warnings about settings that are valid but risky.
 *
 * @param configuration Effective configuration.
 * @returns Warning sentences, empty when nothing is risky.
 */
export function configurationWarnings(configuration: ServerConfiguration): string[] {
  const warnings: string[] = [];
  if (
    configuration.trustProxy &&
    configuration.forwardedSecret === null &&
    CONFIGURATION_HOSTS_ALL_INTERFACES.has(configuration.hostname)
  )
    warnings.push(
      'TRUST_PROXY=true without FORWARDED_SECRET on all interfaces: clients that reach this port directly can fake their address. Bind HOST to the proxy network or set FORWARDED_SECRET.',
    );
  if (configuration.allowedOrigins.includes('*'))
    warnings.push('ALLOWED_ORIGINS=* lets any web page open connections to this relay.');
  if (configuration.internalTestRoomsEnabled) warnings.push('INTERNAL_TEST_ROOMS=true is a development setting.');
  return warnings;
}
