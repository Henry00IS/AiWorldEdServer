/**
 * Protocol version negotiation and capability flags, shared by the relay and
 * the AiWorldEd client. A client announces the newest version it speaks
 * (`version`), the oldest it still speaks (`minVersion`) and the optional
 * features it understands (`caps`); the relay picks the newest version both
 * sides speak and the capabilities both sides know. Optional features are added
 * as capabilities so most additions need no version bump.
 */

/** Newest protocol version this relay speaks. */
export const PROTOCOL_VERSION_MAXIMUM = 3;
/** Oldest protocol version this relay still speaks. */
export const PROTOCOL_VERSION_MINIMUM = 3;
/** Highest version number the wire format allows (fixed 16-bit range). */
export const PROTOCOL_VERSION_LIMIT = 0xffff;

/**
 * Optional features this relay offers. A member only receives messages of a
 * capability both it and the relay announced:
 *
 * - `select`: selection presence, `selected {by, ids}` messages.
 * - `transfer`: transfer links (`transfer.*` messages) and files in chat.
 * - `stats`: `online` (open relay connections) in the welcome, then `stats
 *   {online}` when it changes, at most once every 5 seconds.
 * - `typing`: chat typing presence, `typing` client signals and `typing {users}`
 *   broadcasts of who is typing in the room.
 */
export const PROTOCOL_CAPABILITIES = ['select', 'transfer', 'stats', 'typing'] as const;
/** Union of capability names this relay knows. */
export type ProtocolCapability = (typeof PROTOCOL_CAPABILITIES)[number];
/** Wire format of a capability name: lowercase, dot-separated words. */
export const PROTOCOL_CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
/** Longest capability name. */
export const PROTOCOL_CAPABILITY_LENGTH_MAXIMUM = 32;
/** Most capabilities one hello may announce. */
export const PROTOCOL_CAPABILITIES_MAXIMUM = 32;

/** Version range announced by one side. */
export interface ProtocolVersionRange {
  /** Oldest version spoken. */
  min: number;
  /** Newest version spoken. */
  max: number;
}

/** Result of a version negotiation. */
export type ProtocolNegotiation = { ok: true; version: number } | { ok: false };

/**
 * Picks the newest version both sides speak.
 *
 * @param client Client range (`minVersion` defaults to `version`).
 * @param server Relay range.
 * @returns The agreed version, or `ok: false` when the ranges do not overlap.
 */
export function protocolNegotiate(client: ProtocolVersionRange, server: ProtocolVersionRange): ProtocolNegotiation {
  const version = Math.min(client.max, server.max);
  return version >= Math.max(client.min, server.min) ? { ok: true, version } : { ok: false };
}

/**
 * Keeps the capabilities both sides announced; unknown names are ignored so
 * newer clients can talk to older relays.
 *
 * @param announced Capabilities the client announced.
 * @param offered Capabilities the relay offers.
 * @returns Agreed capabilities in the relay's order.
 */
export function protocolCapabilitiesAgree(
  announced: readonly string[],
  offered: readonly string[] = PROTOCOL_CAPABILITIES,
): string[] {
  const wanted = new Set(announced);
  return offered.filter((capability) => wanted.has(capability));
}

/**
 * Explains a refused handshake to the user.
 *
 * @param client Client range.
 * @param server Relay range.
 * @returns User-facing message.
 */
export function protocolUnsupportedMessage(client: ProtocolVersionRange, server: ProtocolVersionRange): string {
  const relay = server.min === server.max ? `v${server.max}` : `v${server.min}–v${server.max}`;
  const editor = client.min === client.max ? `v${client.max}` : `v${client.min}–v${client.max}`;
  const advice = client.max < server.min ? 'Update your editor.' : 'This server needs an update.';
  return `This server speaks collaboration protocol ${relay}; your editor speaks ${editor}. ${advice}`;
}

/**
 * Explains why a room cannot be joined with the negotiated version.
 *
 * @param roomVersion Version the room was created with.
 * @param yourVersion Version this connection negotiated.
 * @returns User-facing message.
 */
export function protocolMismatchMessage(roomVersion: number, yourVersion: number): string {
  return `This room uses protocol v${roomVersion}; your editor speaks v${yourVersion}. Update or join a compatible room.`;
}
