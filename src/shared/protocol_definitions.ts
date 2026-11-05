/**
 * Dependency-free wire protocol constants and message shapes shared by the
 * relay server and the AiWorldEd client.
 */

/** Protocol identifier that must be sent in the hello message. */
export const PROTOCOL_ID = 'aiworlded-collab';
/**
 * Current protocol version: the version this build speaks when it creates a
 * room. See `protocol_versioning.ts` for the supported range.
 */
export const PROTOCOL_VERSION = 2;
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
/**
 * Binary frame kind: one chunk of a transfer link download, sent by the link
 * owner. Header: [4..7] transfer query id `q` (u32 BE), [8..11] byte offset of
 * the chunk in the file (u32 BE).
 */
export const BINARY_FRAME_KIND_TRANSFER_CHUNK = 3;

/** Bytes the relay asks for per transfer chunk (256 KiB). */
export const TRANSFER_CHUNK_BYTES = 256 * 1024;
/** Largest file a transfer link may serve (100 MiB). */
export const TRANSFER_SIZE_MAXIMUM = 100 * 1024 * 1024;
/** How long a transfer link works, the same as a chat message lives (one hour). */
export const TRANSFER_LINK_LIFETIME_MS = 60 * 60 * 1000;
/** Minimum time between two links of one connection. */
export const TRANSFER_CREATE_INTERVAL_MS = 5000;
/** Path segment after the WebSocket path under which links are served. */
export const TRANSFER_PATH_SEGMENT = 'transfer';
/**
 * A transfer link id: a 43 character base64url token with no file extension;
 * the name and type of the file only travel in the response headers.
 */
export const TRANSFER_LINK_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/**
 * A MIME type the relay serves as is; anything else is
 * application/octet-stream.
 */
export const TRANSFER_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/**
 * Longest served file name in characters, extension included. Owners may send
 * up to four times as much; the relay cleans and shortens it.
 */
export const TRANSFER_NAME_LENGTH_MAXIMUM = 255;

/**
 * File shared in a chat message: the sender's transfer link plus what the file
 * is. Members build the download URL from their own relay URL, so a message can
 * never point anywhere else.
 */
export interface ChatFileAttachment {
  link: string;
  name: string;
  size: number;
  mime: string;
}

/** WebSocket close codes used by the relay. */
export const CLOSE_CODES = {
  protocolViolation: 4001,
  rateLimited: 4002,
  handshakeTimeout: 4003,
  slowConsumer: 4004,
  serverFull: 4005,
  shuttingDown: 4006,
  abuse: 4007,
  protocolUnsupported: 4008,
  originRefused: 4009,
  proxyRefused: 4010,
  tooManyConnections: 4011,
} as const;

/**
 * Edit operation kinds a running operation streams as live previews of a drag
 * or tool. Sent without a lease (a typed value) they are one-shot edits.
 */
export const EDIT_KINDS_LEASED = ['transform'] as const;
/**
 * One-shot edit kinds: field updates, reparents and deletes that need no lock.
 * The relay refuses them only while another member's edit lease covers a
 * target.
 */
export const EDIT_KINDS_ONE_SHOT = ['geometry', 'property', 'texture', 'reparent', 'delete'] as const;
/** Edit operation kinds that introduce new ids. */
export const EDIT_KINDS_CREATING = ['create'] as const;
/** Every edit operation kind. */
export const EDIT_KINDS = [...EDIT_KINDS_LEASED, ...EDIT_KINDS_ONE_SHOT, ...EDIT_KINDS_CREATING] as const;
/** Union of edit operation kinds. */
export type EditKind = (typeof EDIT_KINDS)[number];

/** Stream kinds relayed from the room owner to one member. */
export const STREAM_KINDS = ['snapshot', 'asset'] as const;
/** Union of stream kinds. */
export type StreamKind = (typeof STREAM_KINDS)[number];

/**
 * How long an edit lease lives without renewal. Any accepted edit or
 * `lock.renew` of the holder renews it; once it runs out the relay releases
 * every lock of the holder and broadcasts `locks` with `expired: true`.
 */
export const LOCK_LEASE_MS = 5000;
/**
 * Leases: a member holds at most one edit lease (one running operation, which
 * may cover many objects). `lock.acquire` names the lease with a number that
 * grows per connection; a different number while a lease is active is refused
 * with `lease_busy` unless `replace` ends the old operation first, and the same
 * number adds ids to the running operation. Live previews carry the lease
 * number and are refused with `lease_stale` once it ended. While a lease is
 * active, edits may only touch its ids (`outside_lease`).
 */
/** How often a client renews its lease while an operation is still running. */
export const LOCK_RENEW_INTERVAL_MS = 1500;
/** Most object ids one `select` presence message may list. */
export const SELECT_IDS_MAXIMUM = 256;

/**
 * One edit operation; `d` is opaque editor data relayed verbatim. `p` lists the
 * new parent chain of a `create` or `reparent` (parent first, up to the root):
 * the relay refuses the edit when another member exclusively holds any of
 * them.
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
 * Selection presence relayed to the other members: the top-level ids member
 * `by` has selected. Selection never locks anything and the relay keeps no
 * copy; members resend their selection when somebody joins.
 */
export interface SelectedMessage {
  t: 'selected';
  by: number;
  ids: string[];
}

/**
 * Chat typing presence for members that negotiated the `typing` capability.
 * `users` lists the room members currently flagged as typing (user ids), with
 * the recipient's own id omitted. The relay resets each flag on every signal
 * and clears it after a short countdown or when the member leaves.
 */
export interface TypingMessage {
  t: 'typing';
  users: number[];
}

/**
 * Messages a client may send. `r` is an optional request id echoed in replies
 * and errors.
 */
export type ClientMessage =
  | {
      t: 'hello';
      protocol: typeof PROTOCOL_ID;
      /** Newest version the client speaks. */
      version: number;
      /** Oldest version the client speaks (defaults to `version`). */
      minVersion?: number;
      /** Editor name and build, e.g. `AiWorldEd/0.3.1+a4ac32c`. */
      client: string;
      name?: string;
      /** Optional features the client understands. */
      caps?: string[];
      /** Extension object: unknown keys are ignored (see Protocol evolution). */
      x?: Record<string, unknown>;
    }
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
      /** Extension object: unknown keys are ignored (see Protocol evolution). */
      x?: Record<string, unknown>;
    }
  | { t: 'room.join'; r?: number; room: string; password?: string; discardLocalWork: true; displayName?: string }
  | { t: 'room.leave'; r?: number }
  | { t: 'name.set'; r?: number; name: string }
  | { t: 'chat'; r?: number; text: string; file?: ChatFileAttachment }
  | { t: 'lock.acquire'; r?: number; lease: number; ids: string[]; replace?: boolean; shared?: string[] }
  | { t: 'lock.release'; r?: number; ids?: string[] }
  | { t: 'lock.renew'; lease: number }
  | { t: 'select'; ids: string[] }
  | { t: 'typing'; stop?: boolean }
  | { t: 'edit'; seq: number; ops: EditOperation[]; lease?: number }
  | { t: 'verify.result'; q: number; v: VerifyVerdict }
  | { t: 'asset.request'; r?: number; name: string }
  | { t: 'asset.missing'; to: number; name: string }
  | { t: 'stream.begin'; to: number; stream: number; kind: StreamKind; size: number; name?: string; mime?: string }
  | { t: 'stream.end'; to: number; stream: number }
  | { t: 'stream.abort'; to: number; stream: number; reason?: string }
  | { t: 'transfer.create'; r?: number }
  | { t: 'transfer.info'; q: number; size: number; name: string; mime: string }
  | { t: 'transfer.missing'; q: number };

/**
 * Transfer links (capability `transfer`): the owner asks for a link with
 * `transfer.create` and gets `transfer.created {link, expiresInMs}`. When
 * somebody downloads the link the relay sends `transfer.get {q, link}`; the
 * owner answers `transfer.info {q, size, name, mime}` or `transfer.missing
 * {q}`. The relay then asks for one `transfer.chunk {q, offset, length}` at a
 * time across all downloads of the connection and the owner answers each with a
 * binary transfer chunk frame. Nothing is stored on the relay.
 */
export interface TransferGetMessage {
  t: 'transfer.get';
  q: number;
  link: string;
}

/** Relay request for one chunk of a download. */
export interface TransferChunkMessage {
  t: 'transfer.chunk';
  q: number;
  offset: number;
  length: number;
}

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
  /** Protocol version the room was created with; joiners must speak it. */
  protocol: number;
  /** Editor name and build of the creator, from its hello `client`. */
  editor: string;
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
  | 'lease_busy'
  | 'lease_stale'
  | 'outside_lease'
  | 'rate_limited'
  | 'throttled'
  | 'stream_invalid'
  | 'subscription_limit'
  | 'name_locked'
  | 'invalid_chat'
  | 'chat_rate_limited'
  | 'busy'
  | 'protocol_unsupported'
  | 'protocol_mismatch'
  | 'transfer_rate_limited'
  | 'transfer_unavailable';

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
  /** Shared file, when the message carries one (capability `transfer`). */
  file?: ChatFileAttachment;
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
