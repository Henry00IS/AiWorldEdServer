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
/**
 * Binary frame kind: low-priority presence (viewport cameras and play-mode
 * character pose).
 */
export const BINARY_FRAME_KIND_PRESENCE = 2;

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

/**
 * One edit operation; `d` is opaque editor data relayed verbatim. `p` lists the
 * new parent chain of a `create` or `reparent` (parent first, up to the root):
 * the relay refuses the edit when another member exclusively holds any of them
 * and gives the sender a shared lock on them.
 */
export interface EditOperation {
  k: EditKind;
  ids: string[];
  d?: unknown;
  p?: string[];
}

/**
 * Answers of the room owner to a `verify` query: `ok` when every id in `ids`
 * exists and every id in `anc` is an ancestor of at least one of them,
 * `deleted` when an id no longer exists, `invalid` otherwise.
 */
export const VERIFY_VERDICTS = ['ok', 'invalid', 'deleted'] as const;
/** Union of owner verdicts. */
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/**
 * Why the relay refused locks it could not confirm with the room owner
 * (`lock_unverified`): the owner's verdict, no answer in time, the owner left,
 * or too many queries.
 */
export type VerifyDenial = Exclude<VerifyVerdict, 'ok'> | 'owner_timeout' | 'owner_left' | 'rate_limited';

/**
 * Sent by the relay to the room owner before a member gets shared locks on
 * containers it does not hold yet. `q` is echoed in `verify.result`.
 */
export interface VerifyQueryMessage {
  t: 'verify';
  q: number;
  ids: string[];
  anc: string[];
}

/**
 * Messages a client may send. `r` is an optional request id echoed in replies
 * and errors.
 */
export type ClientMessage =
  | { t: 'hello'; protocol: typeof PROTOCOL_ID; version: number; client: string; name?: string }
  | { t: 'ping'; r?: number }
  | { t: 'room.list'; r?: number }
  | { t: 'room.subscribe'; r?: number }
  | { t: 'room.unsubscribe'; r?: number }
  | {
      t: 'room.create';
      r?: number;
      name: string;
      private: boolean;
      password?: string;
      internalTest?: boolean;
      maxUsers?: number;
      displayName?: string;
    }
  | { t: 'room.join'; r?: number; room: string; password?: string; discardLocalWork: true; displayName?: string }
  | { t: 'room.leave'; r?: number }
  | { t: 'name.set'; r?: number; name: string }
  | { t: 'chat'; r?: number; text: string }
  | { t: 'lock.acquire'; r?: number; ids: string[]; replace?: boolean; shared?: string[] }
  | { t: 'lock.release'; r?: number; ids?: string[] }
  | { t: 'edit'; seq: number; ops: EditOperation[] }
  | { t: 'verify.result'; q: number; v: VerifyVerdict }
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
  /** Display name of the room owner. */
  owner: string;
}

/**
 * Pushed to sessions subscribed with `room.subscribe`: rooms that appeared or
 * changed (`rooms`) and ids of rooms that disappeared from the list
 * (`removed`).
 */
export interface RoomListUpdateMessage {
  t: 'room.list.update';
  rooms: RoomListEntry[];
  removed: string[];
}

/** Member listing entry. */
export interface RoomMemberEntry {
  user: number;
  name: string;
  owner: boolean;
  /**
   * Color slot: the lowest slot free in the room when the member entered;
   * unique among current members.
   */
  color: number;
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
  | 'lock_unverified'
  | 'stream_invalid'
  | 'subscription_limit'
  | 'name_locked'
  | 'invalid_chat'
  | 'chat_rate_limited'
  | 'busy';

/**
 * One chat message as members receive it. `id` grows per room, `at` is the
 * relay clock in epoch milliseconds and `name` and `color` are the sender's
 * room name and color slot. The relay keeps no chat history: members only get
 * messages sent while they are in the room.
 */
export interface ChatMessageEntry {
  id: number;
  from: number;
  name: string;
  color: number;
  text: string;
  at: number;
}

/** Pushed to the other room members for every chat message. */
export interface ChatMessage extends ChatMessageEntry {
  t: 'chat';
}

/** Reply to the sender of a chat message: the message as members got it. */
export interface ChatSentMessage extends ChatMessageEntry {
  t: 'chat.sent';
  r?: number;
}
