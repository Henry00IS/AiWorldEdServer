/**
 * Dependency-free wire protocol constants and message shapes shared by the
 * relay server and the AiWorldEd client.
 */

/** Protocol identifier that must be sent in the hello message. */
export const PROTOCOL_ID = 'aiworlded-collab';
/** Current protocol version. */
export const PROTOCOL_VERSION = 1;
/** WebSocket path served by the relay. */
export const PROTOCOL_WEBSOCKET_PATH = '/ws';

/** First byte of every binary frame. */
export const BINARY_FRAME_MAGIC = 0xa7;
/** Binary frame kind: one chunk of a snapshot or asset stream. */
export const BINARY_FRAME_KIND_STREAM_CHUNK = 1;
/** Size of the fixed binary frame header in bytes. */
export const BINARY_FRAME_HEADER_BYTES = 12;

/** WebSocket close codes used by the relay. */
export const CLOSE_CODES = {
  protocolViolation: 4001,
  rateLimited: 4002,
  handshakeTimeout: 4003,
  slowConsumer: 4004,
  serverFull: 4005,
  shuttingDown: 4006,
} as const;

/** Edit operation kinds that require the sender to hold locks on every id. */
export const EDIT_KINDS_LOCKED = ['transform', 'geometry', 'property', 'texture', 'reparent', 'delete'] as const;
/** Edit operation kinds that introduce new ids. */
export const EDIT_KINDS_CREATING = ['create'] as const;
/** Every edit operation kind. */
export const EDIT_KINDS = [...EDIT_KINDS_LOCKED, ...EDIT_KINDS_CREATING] as const;
/** Union of edit operation kinds. */
export type EditKind = (typeof EDIT_KINDS)[number];

/** Stream kinds relayed from the room owner to one member. */
export const STREAM_KINDS = ['snapshot', 'asset'] as const;
/** Union of stream kinds. */
export type StreamKind = (typeof STREAM_KINDS)[number];

/** One edit operation; `d` is opaque editor data relayed verbatim. */
export interface EditOperation {
  k: EditKind;
  ids: string[];
  d?: unknown;
}

/** Messages a client may send. `r` is an optional request id echoed in replies and errors. */
export type ClientMessage =
  | { t: 'hello'; protocol: typeof PROTOCOL_ID; version: number; client: string; name?: string }
  | { t: 'ping'; r?: number }
  | { t: 'room.list'; r?: number }
  | { t: 'room.create'; r?: number; name: string; private: boolean; password?: string; internalTest?: boolean; maxUsers?: number }
  | { t: 'room.join'; r?: number; room: string; password?: string; discardLocalWork: true }
  | { t: 'room.leave'; r?: number }
  | { t: 'lock.acquire'; r?: number; ids: string[]; replace?: boolean }
  | { t: 'lock.release'; r?: number; ids?: string[] }
  | { t: 'edit'; seq: number; ops: EditOperation[] }
  | { t: 'asset.request'; r?: number; name: string }
  | { t: 'asset.missing'; to: number; name: string }
  | { t: 'stream.begin'; to: number; stream: number; kind: StreamKind; size: number; name?: string; mime?: string }
  | { t: 'stream.end'; to: number; stream: number }
  | { t: 'stream.abort'; to: number; stream: number; reason?: string };

/** Union of client message type names. */
export type ClientMessageType = ClientMessage['t'];

/** Public room listing entry. */
export interface RoomListEntry {
  id: string;
  name: string;
  private: boolean;
  users: number;
  maxUsers: number;
}

/** Member listing entry. */
export interface RoomMemberEntry {
  user: number;
  name: string;
  owner: boolean;
}

/** Error codes sent in `error` messages. */
export type ErrorCode =
  | 'invalid_name'
  | 'weak_password'
  | 'password_required'
  | 'password_not_allowed'
  | 'wrong_password'
  | 'too_many_attempts'
  | 'room_not_found'
  | 'room_full'
  | 'room_limit_ip'
  | 'room_limit_server'
  | 'already_in_room'
  | 'not_in_room'
  | 'not_owner'
  | 'not_synced'
  | 'internal_test_forbidden'
  | 'lock_conflict'
  | 'lock_limit'
  | 'not_locked'
  | 'stream_invalid'
  | 'busy';
