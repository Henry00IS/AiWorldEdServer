/** Decodes and validates text frames into typed client messages. */
import type { ClientMessage, ClientMessageType } from '../shared/protocol_definitions.ts';
import { CLIENT_MESSAGE_SCHEMAS } from './protocol_message_schemas.ts';
import { schemaValidate } from './schema_validator.ts';

/** Decoder verdict. */
export type DecodeResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

/**
 * Parses JSON and validates it against the schema of its declared type.
 *
 * @param text Raw text frame.
 * @returns Typed message or the reason it was rejected.
 */
export function protocolMessageDecode(text: string): DecodeResult {
  const parsed = protocolJsonParseSafely(text);
  if (parsed === undefined) return { ok: false, reason: 'invalid json' };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { ok: false, reason: 'not an object' };
  const type = (parsed as { t?: unknown }).t;
  if (typeof type !== 'string' || !Object.hasOwn(CLIENT_MESSAGE_SCHEMAS, type))
    return { ok: false, reason: 'unknown type' };
  const error = schemaValidate(CLIENT_MESSAGE_SCHEMAS[type as ClientMessageType], parsed);
  return error ? { ok: false, reason: error } : { ok: true, message: parsed as ClientMessage };
}

/**
 * @param text Raw text.
 * @returns Parsed value, or undefined on syntax errors.
 */
function protocolJsonParseSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
