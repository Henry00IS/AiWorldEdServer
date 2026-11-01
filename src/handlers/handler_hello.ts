/**
 * Hello negotiation: picks the newest protocol version both sides speak and the
 * capabilities both know, or refuses the connection with a structured error the
 * editor can show before the socket closes.
 */
import type { ConnectionProtocol, ConnectionSession } from '../connection/connection_session.ts';
import { sessionSendError } from '../connection/connection_session.ts';
import { CLOSE_CODES, type ClientMessage } from '../shared/protocol_definitions.ts';
import {
  protocolCapabilitiesAgree,
  protocolNegotiate,
  protocolUnsupportedMessage,
  PROTOCOL_VERSION_MAXIMUM,
  PROTOCOL_VERSION_MINIMUM,
  type ProtocolVersionRange,
} from '../shared/protocol_versioning.ts';

/** Relay version range. */
const RELAY_VERSIONS: ProtocolVersionRange = { min: PROTOCOL_VERSION_MINIMUM, max: PROTOCOL_VERSION_MAXIMUM };

/** Details of a refused hello. */
export interface HelloRefusal {
  versions: ProtocolVersionRange;
  message: string;
}

/** Outcome of a hello negotiation. */
export type HelloNegotiation = { ok: true; protocol: ConnectionProtocol } | { ok: false; refusal: HelloRefusal };

/**
 * Negotiates the protocol of a connection from its hello.
 *
 * @param message Validated hello.
 * @returns Agreed protocol, or the refusal to send.
 */
export function helloNegotiate(message: Extract<ClientMessage, { t: 'hello' }>): HelloNegotiation {
  const client = { min: Math.min(message.minVersion ?? message.version, message.version), max: message.version };
  const negotiation = protocolNegotiate(client, RELAY_VERSIONS);
  if (!negotiation.ok)
    return {
      ok: false,
      refusal: { versions: RELAY_VERSIONS, message: protocolUnsupportedMessage(client, RELAY_VERSIONS) },
    };
  const caps = new Set(protocolCapabilitiesAgree(message.caps ?? []));
  return { ok: true, protocol: { version: negotiation.version, caps, client: message.client } };
}

/**
 * Sends `error {code:'protocol_unsupported', versions, message}` and closes
 * with 4008.
 *
 * @param session Connection to refuse.
 * @param refusal Refusal details.
 */
export function helloRefuse(session: ConnectionSession, refusal: HelloRefusal): void {
  sessionSendError(session, 'protocol_unsupported', undefined, { ...refusal });
  session.close(CLOSE_CODES.protocolUnsupported, 'protocol unsupported');
}
