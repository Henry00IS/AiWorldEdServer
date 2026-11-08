# AiWorldEd collaboration relay

AiWorldEdServer is the Bun/TypeScript WebSocket relay used by AiWorldEd editors.
It creates rooms, admits members, relays scene edits and owner-supplied snapshots
and assets, coordinates locks and leases, and carries chat, presence, file
transfers and third-party binary messages.

The **room owner is the source of truth**. The relay does not keep a world,
interpret editor scene data, merge scenes, implement undo, or persist chat or
files. Owners provide snapshots, answer verification requests and serve shared
files from their connected editor. If the owner leaves, the room closes; members
are told they are offline and should save locally. There is no owner migration.
Rooms and connection state are in memory and disappear when the relay restarts.
A room password controls admission; declared editor identity is compatibility,
not authentication.

## Install your own relay

You need Docker with Docker Compose and a TLS reverse proxy for a public browser
installation. The repository's root `compose.yaml` builds the supplied Dockerfile;
no published image or separate database is required.

1. Check out this repository and copy `.env.example` to `.env` in the checkout.
   Keep the real file private and out of source control.
2. Configure the root Compose recipe:
   - `BIND_ADDRESS` is required: choose an interface reachable by your proxy,
     not an unintentionally public listener. Review the Compose port publication
     against your network and firewall policy.
   - `TRUST_PROXY=true` enables forwarded client addresses. Generate a strong
     private `FORWARDED_SECRET` of at least 16 characters, and configure the
     proxy to supply the same value in `X-Forwarded-Secret`. Do not send it to
     editor clients. Forward `X-Real-IP` or `X-Forwarded-For` correctly.
   - Set `ALLOWED_ORIGINS` to the origins hosting your editors, for example
     `https://editor.example.com`. Use exact origins unless a wildcard is
     deliberately required.
   - `WEBSOCKET_PATH` selects the WebSocket route (default `/ws`). Other limits
     are optional environment settings. The complete variable reference is
     [SELF_HOSTING.md](docs/SELF_HOSTING.md); defaults and validation live in
     [server_configuration.ts](src/config/server_configuration.ts) and
     [configuration_variable_table.ts](src/config/variables/configuration_variable_table.ts).
   - Leave internal test rooms disabled on public installations.
3. Build and start from the checkout:

   ```sh
   docker compose up -d --build relay
   docker compose ps relay
   ```

4. Terminate TLS at your reverse proxy and expose, for example,
   `wss://relay.example.com/ws`. Forward WebSocket upgrades and preserve the
   configured route. Also route `/healthz` and the transfer URLs under the
   WebSocket route if file sharing is needed. Use timeouts suitable for long-lived
   WebSockets and streaming downloads. Keep direct access to the relay restricted
   to your intended trusted network. The root Compose recipe assumes this
   proxy-terminated TLS arrangement; its health check uses plain HTTP internally.
5. Confirm the public health endpoint and connect an editor:

   ```sh
   curl --fail https://relay.example.com/healthz
   ```

   `GET /healthz` returns `ok` followed by a newline. Compose also has a container
   health check. Health alone does not exercise collaboration: check a
   `hello`/`welcome` exchange and a two-editor create/join session as well.

To update, obtain the desired revision, then run `docker compose up -d --build
relay` again. Existing rooms are not persisted, so arrange updates with users and
have them save first. Retain your private environment configuration. The container
runs as a non-root user with a read-only filesystem; Compose supplies temporary
scratch space and resource limits.

An alternative standalone recipe is supplied in
`deploy/self-host/compose.yaml`, with optional `relay.env` and a certificate
mount. It is a different recipe, not an override for the root file: review its
published listener and TLS settings before using it. The Dockerfile health check
supports direct TLS; the root Compose health-check override is for proxy TLS.

## Protocol

This reference is derived from the closed client schemas, shared wire constants
and handlers in `src/protocol/`, `src/shared/` and `src/handlers/`.

### Transport, types and handshake

Use a WebSocket at the configured route. Control messages are UTF-8 JSON objects
with a literal `t` discriminator. Binary messages have the formats below. Unknown
client message types, unknown fields, invalid types or invalid bounds are protocol
violations; only the explicitly supported `x` extension object admits unknown
keys. Never insert remote strings into HTML: render names, chat, versions and
error text as inert text, and validate any supplied links independently.

Notation: `?` means optional, `int[a..b]` is an inclusive safe-integer range,
`string[a..b]` counts UTF-16 code units on the wire, and `T[n..m]` is an array
length bound. `u32` is an unsigned 32-bit integer; binary integers are big-endian.
An optional request id `r` is echoed only where the schema permits it.

The first message must be `hello` within five seconds:

```json
{
  "t": "hello",
  "protocol": "aiworlded-collab",
  "version": 2,
  "minVersion": 2,
  "client": "MyEditor/1.2.3",
  "name": "Builder",
  "caps": ["select", "transfer", "stats", "typing"]
}
```

Both supported protocol bounds are currently **2**. The relay selects the newest
common protocol version and intersects the offered optional transport capabilities
`select`, `transfer`, `stats`, `typing`. These are unrelated to room software
identity. No common version produces `protocol_unsupported`, followed by close 4008. A room must also use the connection's negotiated protocol version.
`client` identifies the editor name/build shown in the room list.

The response is `welcome` with `protocol:string`, `version:int`,
`versions:{min:int,max:int}`, `caps:string[]`, `user:u32`, `name:string`,
`via:"direct"|"proxy"`, and `limits:object`; `online:int` is present when `stats`
is negotiated. Every `limits` value is numeric. Its fields are:
`maxPayloadBytes`, `streamChunkBytes`, `streamWindowBytes`, `snapshotBytes`,
`assetBytes`, `idsPerMessage`, `opsPerEdit`, `messagesPerSecond`, `roomsPerIp`,
`roomEntriesPerIpPerMinute`, `usersPerRoom`, `locksPerUser`, `presencePerSecond`,
`lockLeaseMs`, `roomListMaximum`, `roomListPushIntervalMs`, `chatIntervalMs`,
`chatTextLength`, `chatTextLines`, `transferIntervalMs`, `transferLifetimeMs`,
`transferBytes`, `customBytesPerSecond`, `customMessagesPerSecond`,
`compatibilityTimeoutMs`. Read effective values rather than assuming defaults.

### Client commands

The following field lists are rendered directly from
`CLIENT_MESSAGE_SCHEMAS` in `src/protocol/protocol_message_schemas.ts`.
The discriminator `t` is the command name. Unless listed, no other fields are
accepted. Bounds below are wire bounds; handlers can impose stricter effective
limits and semantic checks.

- **`hello`**: `protocol: "aiworlded-collab"; version: int[1..65535]; client: string[1..64] matching /^[\x20-\x7e]+$/; name?: string[1..64]; minVersion?: int[1..65535]; caps?: (string[1..32] matching /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)[0..32]; x?: extension(keys<=16, key=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, depth<=4, nodes<=256)`.
- **`ping`**: `r?: int[0..2147483647]`.
- **`room.list`**: `r?: int[0..2147483647]`.
- **`room.subscribe`**: `r?: int[0..2147483647]`.
- **`room.unsubscribe`**: `r?: int[0..2147483647]`.
- **`room.create`**: `name: string[1..512]; private: boolean; r?: int[0..2147483647]; password?: string[1..256]; internalTest?: boolean; maxUsers?: int[2..1000]; displayName?: string[1..64]; x?: extension(keys<=16, key=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, depth<=4, nodes<=256)`.
- **`room.join`**: `room: string[16..16] matching /^[A-Za-z0-9_-]{16}$/; discardLocalWork: true; r?: int[0..2147483647]; password?: string[1..256]; displayName?: string[1..64]; compatibility?: {version: string[1..64]; homeUrl: string[1..256]}`.
- **`compatibility.result`**: `q: int[1..4294967295]; allow: boolean; reason?: "incompatible_client"|"owner_left"|"owner_timeout"; homeUrl?: string[1..256]`.
- **`room.leave`**: `r?: int[0..2147483647]`.
- **`name.set`**: `name: string[1..64]; r?: int[0..2147483647]`.
- **`chat`**: `text: string[1..8192]; r?: int[0..2147483647]; file?: {link: string[43..43] matching /^[A-Za-z0-9_-]{43}$/; name: string[0..1020]; size: int[0..9007199254740991]; mime: string[0..255]}`.
- **`lock.acquire`**: `lease: int[1..9007199254740991]; ids: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..4096]; r?: int[0..2147483647]; replace?: boolean; shared?: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..4096]`.
- **`lock.release`**: `r?: int[0..2147483647]; ids?: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..4096]`.
- **`lock.renew`**: `lease: int[1..9007199254740991]`.
- **`select`**: `ids: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[0..256]`.
- **`typing`**: `stop?: boolean`.
- **`edit`**: `seq: int[0..9007199254740991]; ops: ({k: "transform"|"geometry"|"property"|"texture"|"reparent"|"delete"|"create"; ids: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..4096]; d?: opaque JSON(depth<=32, nodes<=200000); p?: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..4096]})[1..256]; lease?: int[1..9007199254740991]`.
- **`verify.result`**: `q: int[1..4294967295]; v: "ok"|"invalid"|"deleted"`.
- **`asset.request`**: `name: string[1..512] matching /^[^\p{Cc}]+$/u; r?: int[0..2147483647]`.
- **`asset.missing`**: `to: int[1..4294967295]; name: string[1..512] matching /^[^\p{Cc}]+$/u`.
- **`stream.begin`**: `to: int[1..4294967295]; stream: int[1..4294967295]; kind: "snapshot"|"asset"; size: int[0..536870912]; name?: string[1..512] matching /^[^\p{Cc}]+$/u; mime?: string[1..100] matching /^[\w.+-]+\/[\w.+-]+$/`.
- **`stream.end`**: `to: int[1..4294967295]; stream: int[1..4294967295]`.
- **`stream.abort`**: `to: int[1..4294967295]; stream: int[1..4294967295]; reason?: string[1..200] matching /^[\x20-\x7e]+$/`.
- **`transfer.create`**: `r?: int[0..2147483647]`.
- **`transfer.info`**: `q: int[1..4294967295]; size: int[0..9007199254740991]; name: string[0..1020]; mime: string[0..255]`.
- **`transfer.missing`**: `q: int[1..4294967295]`.

### Replies and events

Replies with a permitted request id include `r?:int[0..2147483647]`.

Common records:

- `Room = {id:string, name:string, private:boolean, users:int, maxUsers:int,
owner:string, protocol:int, editor:string}`. `owner` here is a display name.
- `Member = {user:u32, name:string, owner:boolean, color:int}`.
- `LockSet = {by:u32, ids:string[]}`.
- `Operation = {k:"transform"|"geometry"|"property"|"texture"|"reparent"|"delete"|"create",
ids:string[], d?:unknown JSON, p?:string[]}`. `p` is the claimed parent chain,
  parent first. Object ids have 1–64 characters matching `[A-Za-z0-9_.:-]+`.
- `File = {link:string, name:string, size:int, mime:string}`. The link token has
  exactly 43 base64url characters. File names and MIME types are sanitized.

Server messages, excluding the third-party messages documented below:

- `pong`: no additional fields.
- `room.list`: `rooms:Room[]`.
- `room.subscribed`: `rooms:Room[], intervalMs:int`.
- `room.unsubscribed`: no additional fields.
- `room.list.update`: `rooms:Room[], removed:string[]`; changed/new entries and
  ids removed since the preceding list. Internal test rooms are not public listings.
- `room.created`: `room:Room, you:u32, name:string, color:int`.
- `room.joined`: `room:Room, you:u32, name:string, color:int, owner:u32,
members:Member[], locks:LockSet[]`.
- `room.left`: `reason:string`; the owner's explicit leave uses `closed`.
- `room.closed`: `reason:"owner_left", offline:true, message:string`.
- `member.joined`: `user:u32, name:string, color:int`.
- `member.left`: `user:u32`.
- `name.changed`: `name:string`.
- `compatibility.check`: `q:u32, compatibility:{homeUrl:string,version:string}`.
- `snapshot.request`: `for:u32` (owner only).
- `asset.request`: `from:u32, name:string` (to owner).
- `asset.missing`: `from:u32, name:string` (to requesting member).
- `stream.begin`: `from:u32, stream:u32, kind:"snapshot"|"asset", size:int,
name?:string, mime?:string`.
- `stream.end`: `from:u32, stream:u32`.
- `stream.abort`: `stream:u32, reason:string`, with `from:u32` to a recipient or
  `to:u32` to an owner.
- `stream.credit`: `to:u32, stream:u32, delivered:int` (to owner; cumulative
  bytes handed to the recipient).
- `lock.result`: `ok:boolean, add?:string[], remove?:string[], code?:string,
conflicts?:{id:string,by:u32,shared?:boolean}[], why?:string`.
  Success includes `add`/`remove`; failure includes `code` and relevant details.
- `locks`: `by:u32, add?:string[], remove?:string[], expired?:boolean`.
- `verify`: `q:u32, ids:string[], anc:string[]` (owner only).
- `edits`: `list:{from:u32,seq:int,ops?:Operation[]}[]`. The sender's own entry
  omits `ops` and acknowledges its sequence; other members receive the operations.
- `edit.rejected`: `seq:int, reason:string, ids:string[], why?:string`.
- `selected`: `by:u32, ids:string[]` (negotiated `select` only).
- `typing`: `users:u32[]` (negotiated `typing` only; recipient's own id omitted).
- `chat` / `chat.sent`: `id:int, from:u32, name:string, color:int, text:string,
at:int, file?:File`. `at` is epoch milliseconds; only `chat.sent` is the sender's reply.
- `transfer.created`: `link:string, expiresInMs:int`.
- `transfer.get`: `q:u32, link:string` (to the link's connected owner).
- `transfer.chunk`: `q:u32, offset:int, length:int` (request for the next bytes).
- `stats`: `online:int` (negotiated `stats` only, updates at most every five seconds).
- `error`: `code:string, r?:int`, plus the code-specific fields described below.

### Room lifecycle and software identity

A connection belongs to at most one room. Creation makes it the owner and marks
it synced. A private room needs a password satisfying the shared password policy;
`private:false` must not include a password. Room names have additional
normalization/validation in `room_name_policy.ts`. Display names are normalized,
limited to 12 characters by the name policy and made unique within the room;
create/join can supply `displayName`, while `name.set` is allowed outside rooms.
Room color slots are unique among current members and freed on leave.

Joining must explicitly send `discardLocalWork:true` and a compatibility object
containing the fork's single home URL constant (1–256 characters) and actual
editor build version (1–64 characters). Although the wire schema permits an absent
compatibility object, admission then fails closed; it is never a legacy bypass.
Before adding the joiner or requesting a snapshot, the relay sends the identity
unchanged to the owner in `compatibility.check`. Only that owner can answer the
matching query using `compatibility.result`.

The editor admits only an **exact match of both URL and version**, using the same
`APPLICATION_VERSION` source as its settings window and release builds. There
are no scene-schema/capability admission policies. Denial uses
`client_incompatible` with `reason:"incompatible_client"`; an owner may include
its own `homeUrl`. Only bounded HTTP(S) hints are forwarded. Treat this URL as
untrusted: show inert text plus an explicit-click link, never auto-open it or
interpret HTML. Safe external links use `rel="noopener noreferrer"` and
`target="_blank"`.

An unanswered check fails after five seconds with `owner_timeout`; departure
uses `owner_left`. At 32 pending checks per room, the oldest pending attempt is
denied with the retryable timeout reason to admit the newest check. These
lifecycle failures are not software-incompatibility dialogs. The pending joiner
has no room membership or scene data. Approval is followed by a fresh room-state
and capacity check, `room.joined`, membership notification and `snapshot.request`.

### Snapshots, assets and binary frames

The owner answers `snapshot.request` using `stream.begin`, binary chunks and
`stream.end`. Only the owner streams snapshots/assets to a room member. Asset
streams require a name. Stream ids are nonzero and scoped to the recipient.
`stream.end` requires exactly the declared size; finishing a snapshot marks the
recipient synced. A snapshot timeout or abort removes that pending member.
`stream.credit` allows at most the announced stream window in flight. The relay
counts and routes bytes but does not decode the world or asset content; clients
coordinate how their snapshot boundary relates to edits.

Binary kind 1 (stream chunk), all integers big-endian:

| Offset    | Type  | Meaning                                         |
| --------- | ----- | ----------------------------------------------- |
| 0         | u8    | `0xA7`                                          |
| 1         | u8    | `1`                                             |
| 2–3       | u16   | zero                                            |
| 4–7       | u32   | stream id                                       |
| 8–11      | u32   | target user when sent; sender user when relayed |
| 12 onward | bytes | nonempty chunk, at most 256 KiB by default      |

Kind 2 is low-priority presence, **not** this 12-byte format. Client header:
magic, kind `2`, format version `1`, entry count (four u8 values). Relaying inserts
a sender u32 after that header. At most six 18-byte entries follow: id:u8,
position:3×float32, packed smallest-three quaternion:u32, and fov/flags:u8.
Camera ids are 0–15 with fov 1–179; character id is 255, using flag bits 1, 2 and 4.
Coordinates must be finite and within absolute value 1,000,000. See
`src/shared/presence_frame.ts` for packing. Only synced members send presence;
it is latest-only and may be dropped under load.

### Edits, locks and leases

`edit` carries opaque JSON `d`; the relay checks envelope structure, ids, locks,
parent claims, sequencing/rate budgets and lease rules, not scene semantics.
Accepted edits are relayed in relay order. Rejected edits are explicit and must
not be treated as committed. Clients implement scene changes, undo, snapshots
and merging themselves.

`lock.acquire` is all-or-nothing. `ids` requests exclusive locks; `shared` names
shared ancestor/container locks. One member has one active edit lease, identified
by a monotonically growing positive safe integer. Reusing the active lease adds
ids; another lease needs `replace:true` or gets `lease_busy`. Releasing all locks
ends the lease. Selection never acquires locks.

Lease-bound edits must match the active lease (`lease_stale`) and remain within
its ids (`outside_lease`); conflicting holders cause `lock_conflict`. Parent
chains must not cross another member's exclusive locks. One-shot edits without
a lease still undergo lock/conflict checks. New ids and deletions update lock
ownership under the existing edit rules. Scene and custom locks have separate
key namespaces but share the room's total lock budget.

For previously unheld shared containers, the relay may ask the owner `verify`.
The owner answers `verify.result` with `ok`, `invalid` or `deleted`; it checks ids
exist and the claimed ancestor relationships. Queries expire after five seconds.
A sender's later edits, lock operations and custom frames wait in its same
bounded FIFO while verification is pending; custom frames cannot overtake an
earlier edit. `lock_unverified` includes `why` (`invalid`, `deleted`,
`owner_timeout`, `owner_left`, `rate_limited`).

Accepted edits or renewals extend a lease's five-second idle deadline; renew
about every 1.5 seconds while an operation is active. There is also a 60-second
limit without accepted edit progress and a ten-minute total lifetime. Expiry
releases locks and sends `locks {expired:true}`, including to the holder, whose
client must revert uncommitted previews. Leaving/disconnecting releases locks.

### Chat, typing and file-transfer chunks

Text chat is a single JSON `chat` message, **not a 256 KiB chunk stream**. It is
normalized by `chat_text_policy.ts`: NFC, normalized newlines and removal of
unsafe/invisible characters. Default limits are 2,000 code points, 20 lines and
one accepted message every five seconds; raw wire input allows up to 8,192
UTF-16 units before normalization. Empty/overlong/too-many-line messages return
`invalid_chat`; fast sends return `chat_rate_limited` with `retryAfterMs`.
There is no chat history. Each recipient has a low-priority 64-message FIFO;
when full its oldest waiting chat is dropped. Render text inertly.

`typing` starts/refreshes a ten-second indicator, and `typing {stop:true}` clears
it. Accepted chat and leaving also clear it. Only peers with the negotiated
`typing` capability receive the user list; other clients may safely ignore it.

With negotiated `transfer`, `transfer.create` produces a one-hour link token,
at most once every five seconds per owner connection. A chat `file` must refer
to a live link owned by its sender. File bytes are **not uploaded or stored** by
the relay. HTTP downloads use `<WebSocket route>/transfer/<link>` on the relay
origin. The link owner must stay connected and answer `transfer.get` with
`transfer.info` or `transfer.missing`. The relay requests byte ranges through
`transfer.chunk`, and the owner answers with binary kind 3:

`magic:u8=0xA7, kind:u8=3, reserved:u16=0, q:u32, offset:u32, payload:bytes`.

Chunks are at most 256 KiB; files are at most 100 MiB, with up to 16 concurrent
downloads per owner and a 20-second reply timeout. Tokens stop working when the
owner disconnects or the relay restarts. GET, HEAD, OPTIONS and a single HTTP
byte Range are supported. Responses sanitize names/MIME and use conservative
download behavior; query flags `raw` / `download` control raw delivery/download.
The HTTP handler also supports safe preview metadata for crawlers; clients must
not assume an arbitrary shared file is an executable web page.

### Errors, reason codes and close codes

The `error.code` literals below are extracted from the shared `ErrorCode` type.
Malformed wire messages close the connection rather than becoming domain errors.
Other details are code-specific: `invalid_name` can carry `reason`/`field`,
`weak_password` carries `issues`, password/join failures carry their code,
`stream_invalid` can carry `to`/`stream`/`detail`, rate errors may carry
`retryAfterMs`, protocol errors carry version ranges or room/connection versions
and a `message`. Incompatibility can include the validated `homeUrl` hint.
Lock failures use `lock.result {ok:false,code,...}`; edit failures use
`edit.rejected {seq,reason,ids,why?}`. Inspect the discriminator before deciding
which failure shape to handle.

`owner_timeout`, `owner_left`, `client_incompatible`, `custom_rate_limited`, `custom_too_large`, `custom_target_invalid`, `invalid_name`, `weak_password`, `password_required`, `password_not_allowed`, `wrong_password`, `too_many_attempts`, `room_not_found`, `room_full`, `room_limit_ip`, `room_limit_server`, `already_in_room`, `not_in_room`, `not_owner`, `not_synced`, `internal_test_forbidden`, `lock_conflict`, `lock_limit`, `not_locked`, `lock_unverified`, `lease_busy`, `lease_stale`, `outside_lease`, `rate_limited`, `throttled`, `stream_invalid`, `subscription_limit`, `name_locked`, `invalid_chat`, `chat_rate_limited`, `busy`, `protocol_unsupported`, `protocol_mismatch`, `transfer_rate_limited`, `transfer_unavailable`.

Chat reasons: `empty`, `too_long`, `too_many_lines`. Compatibility reasons: `incompatible_client`, `owner_timeout`, `owner_left`. Verification `why`: `invalid`, `deleted`, `owner_timeout`, `owner_left`, `rate_limited`.

| Close code | Meaning             |
| ---------- | ------------------- |
| 4001       | protocolViolation   |
| 4002       | rateLimited         |
| 4003       | handshakeTimeout    |
| 4004       | slowConsumer        |
| 4005       | serverFull          |
| 4006       | shuttingDown        |
| 4007       | abuse               |
| 4008       | protocolUnsupported |
| 4009       | originRefused       |
| 4010       | proxyRefused        |
| 4011       | tooManyConnections  |

Bun may also close oversized frames with 1009. A protocol-unsupported refusal sends its error before closing. Refused upgrades may become HTTP 403/429/503 when the bounded refusal queue is full.

### Rate limits and quotas

The following numeric defaults are read directly from `configurationDefault()`. Names containing `Bytes` are byte budgets, `Ms` milliseconds and `Seconds` seconds; `PerSecond`/`PerMinute` are rates, and corresponding `Burst` fields are token-bucket burst allowances. Other maximum/count fields are resource caps. The custom channel is the sliding-window exception described below. Environment configuration may change effective values; `welcome.limits` exposes the subset listed above.

| Configuration field            | Default     |
| ------------------------------ | ----------- |
| `compatibilityTimeoutMs`       | 5,000       |
| `compatibilityPendingPerRoom`  | 32          |
| `customBytesPerSecond`         | 262,144     |
| `customMessagesPerSecond`      | 4,096       |
| `maxPayloadBytes`              | 1,048,576   |
| `streamChunkBytesMaximum`      | 262,144     |
| `handshakeTimeoutMs`           | 5,000       |
| `idleTimeoutSeconds`           | 60          |
| `messagesPerSecond`            | 120         |
| `messageBurst`                 | 400         |
| `bytesPerSecond`               | 16,777,216  |
| `byteBurst`                    | 33,554,432  |
| `connectionsPerIp`             | 24          |
| `connectionsTotal`             | 2,000       |
| `refusedSocketsMaximum`        | 256         |
| `roomsPerIp`                   | 8           |
| `roomsTotal`                   | 500         |
| `usersPerRoomDefault`          | 16          |
| `usersPerRoomMaximum`          | 32          |
| `locksPerUser`                 | 20,000      |
| `locksPerRoom`                 | 100,000     |
| `outboundQueueBytesMaximum`    | 16,777,216  |
| `outboundBacklogBytesTotal`    | 268,435,456 |
| `socketBufferHighWaterBytes`   | 1,048,576   |
| `snapshotBytesMaximum`         | 268,435,456 |
| `assetBytesMaximum`            | 67,108,864  |
| `streamWindowBytes`            | 4,194,304   |
| `streamsPerRecipient`          | 8           |
| `snapshotTimeoutMs`            | 60,000      |
| `joinFailuresPerIpPerMinute`   | 10          |
| `joinFailuresPerRoomPerMinute` | 30          |
| `passwordHashConcurrency`      | 4           |
| `passwordHashConcurrencyPerIp` | 1           |
| `roomEntriesPerIpPerMinute`    | 30          |
| `roomEntryBurstPerIp`          | 10          |
| `roomListMaximum`              | 200         |
| `roomListSubscribersMaximum`   | 1,000       |
| `roomListPushIntervalMs`       | 500         |
| `presencePerSecond`            | 10          |
| `presenceBurst`                | 20          |
| `presenceHighWaterBytes`       | 65,536      |
| `chatIntervalMs`               | 5,000       |
| `chatTextLengthMaximum`        | 2,000       |
| `chatTextLinesMaximum`         | 20          |
| `chatPendingPerRecipient`      | 64          |
| `verifyTimeoutMs`              | 5,000       |
| `verifyPerMemberPerSecond`     | 10          |
| `verifyPerMemberBurst`         | 20          |
| `verifyPerRoomPerSecond`       | 50          |
| `verifyPerRoomBurst`           | 100         |
| `verifyQueueMessagesMaximum`   | 64          |
| `verifyQueueBytesMaximum`      | 4,194,304   |
| `lockLeaseMs`                  | 5,000       |
| `lockLeaseIdleMaximumMs`       | 60,000      |
| `lockLeaseTotalMaximumMs`      | 600,000     |
| `lockLeaseSweepMs`             | 500         |
| `leasesPerSecond`              | 10          |
| `leaseBurst`                   | 20          |
| `leaseRenewsPerSecond`         | 4           |
| `leaseRenewBurst`              | 8           |
| `oneShotEditsPerSecond`        | 20          |
| `oneShotEditBurst`             | 60          |
| `oneShotEditsPerRoomPerSecond` | 200         |
| `oneShotEditRoomBurst`         | 400         |
| `liveEditsPerSecond`           | 60          |
| `liveEditBurst`                | 120         |
| `bulkIdsPerSecond`             | 10,000      |
| `bulkIdBurst`                  | 250,000     |
| `selectsPerSecond`             | 10          |
| `selectBurst`                  | 20          |
| `typingExpiryMs`               | 10,000      |
| `abuseDecayPerSecond`          | 1           |
| `abuseThrottleScore`           | 20          |
| `abuseDisconnectScore`         | 60          |
| `abuseRoomCooldownMs`          | 60,000      |
| `transferLinkLifetimeMs`       | 3,600,000   |
| `transferCreateIntervalMs`     | 5,000       |
| `transferSizeMaximum`          | 104,857,600 |
| `transferChunkBytes`           | 262,144     |
| `transferDownloadsPerOwner`    | 16          |
| `transferReplyTimeoutMs`       | 20,000      |

Rate abuse can throttle or disconnect clients under the existing abuse scorer. Selection/presence are lossy under load; chat has its own FIFO policy. Custom byte/frame-window refusals are explicit and add no abuse points. Per-room lock totals are independent between rooms. See [SELF_HOSTING.md](docs/SELF_HOSTING.md) for environment-variable names and validation bounds.

## Third-party custom messages

This is a fully general, bidirectional binary application channel. The relay
never parses application payload bytes or persists application state. Forks can
choose their own encoding and may use it for previews, progress, pings, UI hints
or fully self-managed state. Use ordinary **edits** for changes that should
participate in the editor's scene serialization, undo, snapshots and merge.
Custom traffic does not automatically acquire those semantics.

### Binary frame and routing

| Offset    | Type  | Meaning                                                         |
| --------- | ----- | --------------------------------------------------------------- |
| 0         | u8    | magic `0xA7`                                                    |
| 1         | u8    | kind `4`                                                        |
| 2–3       | u16   | UTF-8 guard byte length, 0–16,384                               |
| 4–7       | u32   | sender correlation id `r`                                       |
| 8–11      | u32   | target member; zero means owner (or owner-authorized broadcast) |
| 12 onward | bytes | guard JSON, followed immediately by opaque payload bytes        |

A zero-length guard means `{}`. Otherwise it must be a closed JSON object with
only the following optional fields:

`broadcast?: boolean; lease?: int[1..9007199254740991]; ids?: (string[1..64] matching /^[A-Za-z0-9_.:-]+$/)[1..256]`.

Members may send only to the owner (peer zero). The owner may send to a specific synced member id, or use peer zero with `broadcast:true` to reach all other synced members. No member-to-member or member-to-everyone path exists; an owner may relay traffic itself. Recipients see the sender's user id rewritten into bytes 8–11. Both sender and recipient must have finished joining and syncing. A nonexistent/forbidden/unsynced target yields `custom_target_invalid`; an unsynced sender gets `not_synced`. Broadcast excludes the owner and skips unsynced members.

Successful routing replies with `custom.sent {r:u32}`. Errors use `error {r:u32,code:string}`. Correlation is relay acceptance, not an application acknowledgement; implement your own acknowledgement if your protocol needs one.

### Limits, ordering and optional locks

- Payloads are limited to **256 KiB per message** and **256 KiB in a rolling one-second window per sender**, with at most **4096 frames** in that window. Empty payloads cost one byte. Hundreds of small messages may pass in a second; this is not a one-message-per-second gate. A broadcast charges the sender once, not once per recipient.
- A single oversized payload gets `custom_too_large`; window excess gets `custom_rate_limited`, not a silent drop. Rejected window attempts consume no extra credit and add no abuse points. Attempts admitted by the rate window spend the sender's budget even if later routing/lock validation refuses them. Malformed envelopes remain protocol violations. General connection protections still apply.
- All outbound traffic shares the original **16 MiB** per-connection limit, counting the server queue **plus socket buffered bytes**. Exceeding it disconnects that receiver with close 4004. This measures network backlog, not application-level consumption; forks needing stronger acknowledgement must define it themselves.
- The editor has a separate bounded custom send FIFO, paced to the default byte/frame limits and yielding between batches. Ready edits/control messages take priority over unsent custom traffic. Custom FIFO order is preserved. Once on the wire, custom frames enter the same per-sender verification-hold FIFO as edits/locks, count toward its 64-frame/4-MiB defaults, and cannot overtake an earlier edit. Recipient delivery uses the ordered outbound queue. Network arrival jitter may still cause an explicit rate refusal.
- Optional `lease`/`ids` guards reuse the scene edit-lock validation: stale leases yield `lease_stale`, ids outside the active operation yield `outside_lease`, and another holder yields `lock_conflict`. Guarded custom messages do not renew leases or commit scene edits.

Custom keys use a separate room-local namespace from scene ids. Commands and exact bounds:

- **`custom.lock.acquire`**: `keys: (string[1..256])[1..256]; r?: int[0..2147483647]`.
- **`custom.lock.release`**: `r?: int[0..2147483647]; keys?: (string[1..256])[1..256]`.

Acquire replies `custom.lock.acquired {r?:int,keys:string[]}`; release replies `custom.lock.released {r?:int,keys:string[]}`. Omitting release keys releases all the sender's custom keys. Conflicts and limits are explicit errors. Scene and custom tables share the configured total lock budget **of that room only**, and release keys on leave/disconnect. Custom locks are not scene edit leases; optional scene guards above still use the ordinary lease rules.

### Fork example

In the editor, `runtime.custom` exposes `sendToOwner(bytes, guard?)`, `sendToMember(memberId, bytes, guard?)`, `sendToAll(bytes, guard?)`, `onMessage(listener)`, `lockAcquire(keys)` and `lockRelease(keys?)`. The listener receives `(senderId, bytes)`; one throwing listener does not stop the others. Sending returns a promise that rejects on explicit relay refusal.

A terrain painter can hold a normal scene lease, stream compact binary previews with `{lease, ids:[terrainId]}`, and commit its geometry through an ordinary edit before releasing the lease. For a self-managed activity, it can instead lock an opaque custom key such as `terrain:preview` and define its own state/acknowledgement protocol. That custom state does not automatically become editor scene data.

```ts
const stop = runtime.custom.onMessage((senderId, bytes) => {
  // Decode only your fork's own protocol; the relay leaves these bytes opaque.
  showTerrainPreview(senderId, bytes);
});
await runtime.custom.sendToOwner(previewBytes, { lease, ids: [terrainId] });
// Only the owner may call these:
await runtime.custom.sendToMember(memberId, previewBytes);
await runtime.custom.sendToAll(previewBytes);
// On teardown:
stop();
```

Unknown/namespaced scene fields are preserved by the editor through sync, edits, merge and save/load. Current editor-written values take precedence at every depth. Exhaustive typed known-field records must be updated when adding serialized fields or node kinds; custom protocols should still define ownership of their own data.
