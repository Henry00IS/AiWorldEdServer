/** Closed schemas for every client message of protocol version 2. */
import {
  EDIT_KINDS,
  PROTOCOL_ID,
  SELECT_IDS_MAXIMUM,
  STREAM_KINDS,
  VERIFY_VERDICTS,
  type ClientMessageType,
} from '../shared/protocol_definitions.ts';
import {
  PROTOCOL_CAPABILITIES_MAXIMUM,
  PROTOCOL_CAPABILITY_LENGTH_MAXIMUM,
  PROTOCOL_CAPABILITY_PATTERN,
  PROTOCOL_VERSION_LIMIT,
} from '../shared/protocol_versioning.ts';
import { CHAT_TEXT_WIRE_MAXIMUM } from '../shared/chat_text_policy.ts';
import type { Schema } from './schema_validator.ts';

/** Absolute protocol caps (configuration may be stricter, never looser). */
export const PROTOCOL_CAPS = {
  idsPerMessage: 4096,
  opsPerEdit: 256,
  opaqueDepth: 32,
  opaqueNodes: 200_000,
  streamSizeMaximum: 512 * 1024 * 1024,
  passwordInputMaximum: 256,
  assetNameMaximum: 512,
} as const;

const SCHEMA_REQUEST_ID: Schema = { type: 'int', min: 0, max: 0x7fffffff };
const SCHEMA_USER_ID: Schema = { type: 'int', min: 1, max: 0xffffffff };
const SCHEMA_LEASE_ID: Schema = { type: 'int', min: 1, max: Number.MAX_SAFE_INTEGER };
const SCHEMA_STREAM_ID: Schema = { type: 'int', min: 1, max: 0xffffffff };
const SCHEMA_OBJECT_ID: Schema = { type: 'string', min: 1, max: 64, pattern: /^[A-Za-z0-9_.:-]+$/ };
const SCHEMA_OBJECT_IDS: Schema = { type: 'array', items: SCHEMA_OBJECT_ID, min: 1, max: PROTOCOL_CAPS.idsPerMessage };
const SCHEMA_ROOM_ID: Schema = { type: 'string', min: 16, max: 16, pattern: /^[A-Za-z0-9_-]{16}$/ };
const SCHEMA_ASSET_NAME: Schema = {
  type: 'string',
  min: 1,
  max: PROTOCOL_CAPS.assetNameMaximum,
  pattern: /^[^\p{Cc}]+$/u,
};
const SCHEMA_PROTOCOL_VERSION: Schema = { type: 'int', min: 1, max: PROTOCOL_VERSION_LIMIT };
const SCHEMA_CAPABILITIES: Schema = {
  type: 'array',
  items: { type: 'string', min: 1, max: PROTOCOL_CAPABILITY_LENGTH_MAXIMUM, pattern: PROTOCOL_CAPABILITY_PATTERN },
  min: 0,
  max: PROTOCOL_CAPABILITIES_MAXIMUM,
};
/**
 * Extension object: the only place where unknown keys are accepted (and
 * ignored).
 */
const SCHEMA_EXTENSION: Schema = {
  type: 'extension',
  maxKeys: 16,
  key: PROTOCOL_CAPABILITY_PATTERN,
  maxDepth: 4,
  maxNodes: 256,
};
const SCHEMA_DISPLAY_NAME: Schema = { type: 'string', min: 1, max: 64 };
const SCHEMA_EDIT_OPERATION: Schema = {
  type: 'object',
  required: { k: { type: 'enum', values: EDIT_KINDS }, ids: SCHEMA_OBJECT_IDS },
  optional: {
    d: { type: 'opaque', maxDepth: PROTOCOL_CAPS.opaqueDepth, maxNodes: PROTOCOL_CAPS.opaqueNodes },
    p: SCHEMA_OBJECT_IDS,
  },
};

/**
 * Builds a closed object schema with the type tag and optional request id.
 *
 * @param type Message type literal.
 * @param required Additional required fields.
 * @param optional Additional optional fields.
 * @returns Message schema.
 */
function messageSchema(
  type: ClientMessageType,
  required: Record<string, Schema> = {},
  optional: Record<string, Schema> = {},
): Schema {
  return {
    type: 'object',
    required: { t: { type: 'literal', value: type }, ...required },
    optional: { r: SCHEMA_REQUEST_ID, ...optional },
  };
}

/** Schema per client message type. */
export const CLIENT_MESSAGE_SCHEMAS: Readonly<Record<ClientMessageType, Schema>> = {
  hello: {
    type: 'object',
    required: {
      t: { type: 'literal', value: 'hello' },
      protocol: { type: 'literal', value: PROTOCOL_ID },
      version: SCHEMA_PROTOCOL_VERSION,
      client: { type: 'string', min: 1, max: 64, pattern: /^[\x20-\x7e]+$/ },
    },
    optional: {
      name: { type: 'string', min: 1, max: 64 },
      minVersion: SCHEMA_PROTOCOL_VERSION,
      caps: SCHEMA_CAPABILITIES,
      x: SCHEMA_EXTENSION,
    },
  },
  ping: messageSchema('ping'),
  'room.list': messageSchema('room.list'),
  'room.subscribe': messageSchema('room.subscribe'),
  'room.unsubscribe': messageSchema('room.unsubscribe'),
  'room.create': messageSchema(
    'room.create',
    { name: { type: 'string', min: 1, max: 512 }, private: { type: 'bool' } },
    {
      password: { type: 'string', min: 1, max: PROTOCOL_CAPS.passwordInputMaximum },
      internalTest: { type: 'bool' },
      maxUsers: { type: 'int', min: 2, max: 1000 },
      displayName: SCHEMA_DISPLAY_NAME,
      x: SCHEMA_EXTENSION,
    },
  ),
  'room.join': messageSchema(
    'room.join',
    { room: SCHEMA_ROOM_ID, discardLocalWork: { type: 'literal', value: true } },
    { password: { type: 'string', min: 1, max: PROTOCOL_CAPS.passwordInputMaximum }, displayName: SCHEMA_DISPLAY_NAME },
  ),
  'room.leave': messageSchema('room.leave'),
  'name.set': messageSchema('name.set', { name: SCHEMA_DISPLAY_NAME }),
  chat: messageSchema('chat', { text: { type: 'string', min: 1, max: CHAT_TEXT_WIRE_MAXIMUM } }),
  'lock.acquire': messageSchema(
    'lock.acquire',
    { lease: SCHEMA_LEASE_ID, ids: SCHEMA_OBJECT_IDS },
    { replace: { type: 'bool' }, shared: SCHEMA_OBJECT_IDS },
  ),
  'lock.release': messageSchema('lock.release', {}, { ids: SCHEMA_OBJECT_IDS }),
  'lock.renew': { type: 'object', required: { t: { type: 'literal', value: 'lock.renew' }, lease: SCHEMA_LEASE_ID } },
  select: {
    type: 'object',
    required: {
      t: { type: 'literal', value: 'select' },
      ids: { type: 'array', items: SCHEMA_OBJECT_ID, min: 0, max: SELECT_IDS_MAXIMUM },
    },
  },
  edit: {
    type: 'object',
    required: {
      t: { type: 'literal', value: 'edit' },
      seq: { type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
      ops: { type: 'array', items: SCHEMA_EDIT_OPERATION, min: 1, max: PROTOCOL_CAPS.opsPerEdit },
    },
    optional: { lease: SCHEMA_LEASE_ID },
  },
  'verify.result': {
    type: 'object',
    required: {
      t: { type: 'literal', value: 'verify.result' },
      q: { type: 'int', min: 1, max: 0xffffffff },
      v: { type: 'enum', values: VERIFY_VERDICTS },
    },
  },
  'asset.request': messageSchema('asset.request', { name: SCHEMA_ASSET_NAME }),
  'asset.missing': {
    type: 'object',
    required: { t: { type: 'literal', value: 'asset.missing' }, to: SCHEMA_USER_ID, name: SCHEMA_ASSET_NAME },
  },
  'stream.begin': {
    type: 'object',
    required: {
      t: { type: 'literal', value: 'stream.begin' },
      to: SCHEMA_USER_ID,
      stream: SCHEMA_STREAM_ID,
      kind: { type: 'enum', values: STREAM_KINDS },
      size: { type: 'int', min: 0, max: PROTOCOL_CAPS.streamSizeMaximum },
    },
    optional: { name: SCHEMA_ASSET_NAME, mime: { type: 'string', min: 1, max: 100, pattern: /^[\w.+-]+\/[\w.+-]+$/ } },
  },
  'stream.end': {
    type: 'object',
    required: { t: { type: 'literal', value: 'stream.end' }, to: SCHEMA_USER_ID, stream: SCHEMA_STREAM_ID },
  },
  'stream.abort': {
    type: 'object',
    required: { t: { type: 'literal', value: 'stream.abort' }, to: SCHEMA_USER_ID, stream: SCHEMA_STREAM_ID },
    optional: { reason: { type: 'string', min: 1, max: 200, pattern: /^[\x20-\x7e]+$/ } },
  },
};
