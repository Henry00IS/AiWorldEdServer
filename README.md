# aiworlded-server

Collaborative level editing relay for [AiWorldEd](https://github.com/Henry00IS/AiWorldEd).
A small, fast Bun + TypeScript WebSocket service. It **never holds the world**:
it only negotiates between the room owner (who has the project on disk) and the
other users, relays edits through short-lived per-recipient queues, and enforces
selection locks.

Contributors and agents: read [AGENTS.md](AGENTS.md) for the code standards and
server rules before changing anything.

The official public relay is `wss://aiworlded.00labs.net/ws`; editor builds connect to it by
default.

```
bun install
bun test            # unit + integration tests (real local server, dummy proxy secret)
bun run typecheck
bun run start       # listens on 0.0.0.0:8081 (HOST / PORT override)
```

## Architecture

```
AiWorldEd client ──wss──► reverse proxy (TLS, X-Real-IP, optional X-Forwarded-Secret) ──ws──► relay :8081
```

| Path              | Role                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/`     | Dependency-free modules the client can import directly: protocol constants and types, binary frame codec, password policy, password generator, room/display name rules. |
| `src/protocol/`   | Strict closed-object schema validator and the schema of every client message.                                                                                           |
| `src/network/`    | Proxy trust (secret check, client IP), Origin allow list, token bucket, per-key counters, failure windows.                                                              |
| `src/connection/` | Per-connection session state and the bounded, coalescing outbound queue.                                                                                                |
| `src/rooms/`      | Room, lock table, registry (per-IP / total room limits), broadcast helpers.                                                                                             |
| `src/handlers/`   | Message handlers: rooms, locks, edits, streams/assets.                                                                                                                  |
| `src/server/`     | `ServerCore` (handshake, rate limits, dispatch, lifecycle) and the `Bun.serve` wiring.                                                                                  |

Memory model: a room is metadata + members + lock table + the state of streams
in flight. Edits exist only in recipients' outbound queues until the socket
accepts them, then they are dropped. Each edit is serialized once and the same
string is shared by all recipient queues. Consecutive queued edits are sent as one
`edits` frame ("replicate these N edits").

## Protocol (version 1)

Text frames are JSON objects with a `t` type. Every client message is checked against
a strict schema: unknown types, unknown fields, wrong types, out-of-range values or
`__proto__` tricks close the connection with `4001`. Binary frames are only used for
stream chunks and presence. An optional `r` (int 0..2^31-1) on requests is echoed back in replies and errors.

### Handshake

The first frame must be `hello` within 5 s:

```json
{ "t": "hello", "protocol": "aiworlded-collab", "version": 1, "client": "AiWorldEd/0.1", "name": "Henry" }
```

Reply: `{"t":"welcome","protocol":"aiworlded-collab","version":1,"user":7,"name":"Henry","via":"proxy","limits":{...}}`.
Display names are at most 12 characters (trimmed, no control characters). A longer hello name is
cut to 12; a missing or invalid one becomes `User N` (`N` = user id modulo 10^7).
`via` is `proxy` when the request carried the correct `X-Forwarded-Secret`, otherwise `direct`.
`limits` reports the effective limits (payload, chunk, window, snapshot/asset sizes, ids per
message, ops per edit, messages per second, rooms per IP, room entries per IP per minute, users per room, locks per user, presence
rate, `roomListMaximum`, `roomListPushIntervalMs`, and the chat limits `chatIntervalMs`, `chatTextLength`
and `chatTextLines`).
Every relay supports the live room list (`room.subscribe`); there is no feature negotiation.

### Client → server

| Type                | Fields                                                                                                   | Notes                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`              |                                                                                                          | → `pong`                                                                                                                                                                                                                                |
| `room.list`         |                                                                                                          | → `room.list {rooms:[{id,name,private,users,maxUsers,owner}]}`. `owner` is the owner's display name. Private rooms are flagged and reveal nothing else.                                                                                 |
| `room.subscribe`    |                                                                                                          | → `room.subscribed {rooms, intervalMs}` (full list), then `room.list.update` pushes until unsubscribed or disconnected. Error `subscription_limit` when the relay has too many subscribers.                                             |
| `room.unsubscribe`  |                                                                                                          | → `room.unsubscribed`. Not an error without a subscription.                                                                                                                                                                             |
| `room.create`       | `name`, `private`, `password?`, `maxUsers?` (clamped to 32, default 16), `internalTest?`, `displayName?` | → `room.created {room, you, name, color}`. Creator becomes owner. One room per connection.                                                                                                                                              |
| `room.join`         | `room`, `discardLocalWork: true`, `password?`, `displayName?`                                            | → `room.joined {room, you, name, color, owner, members, locks}` (`name` is the joiner's final, unique name); members are `{user, name, owner, color}`. `discardLocalWork` must be literally `true`: joining always discards local work. |
| `room.leave`        |                                                                                                          | → `room.left`. If the owner leaves, the room closes.                                                                                                                                                                                    |
| `name.set`          | `name`                                                                                                   | Outside a room → `name.changed {name}`. Inside a room → error `name_locked`: a member's name is fixed until it leaves.                                                                                                                  |
| `chat`              | `text` (≤8192 UTF-16 units on the wire)                                                                  | Room members only. → `chat.sent {id, from, name, color, text, at}`; others get `chat` with the same fields. See Chat.                                                                                                                   |
| `lock.acquire`      | `ids[]`, `replace?`, `shared?[]`                                                                         | All-or-nothing. → `lock.result {ok:true, add, remove}` or `{ok:false, code:'lock_conflict', conflicts:[{id,by}]}` / `lock_limit`. `replace:true` atomically swaps the whole selection (releases held ids not in `ids`).                 |
| `verify.result`     | `q`, `v: ok\|invalid\|deleted`                                                                           | Owner only: answer to a relay `verify` query (see Owner verification). Does not count against the owner's rate limits.                                                                                                                  |
| `lock.release`      | `ids?`                                                                                                   | Omit `ids` to release everything.                                                                                                                                                                                                       |
| `edit`              | `seq`, `ops:[{k, ids, d?}]`                                                                              | See edit rules. Rejection: `edit.rejected {seq, reason, ids}`; no ack on success.                                                                                                                                                       |
| `asset.request`     | `name`                                                                                                   | Member asks the owner for an asset (relayed as `asset.request {from, name}`).                                                                                                                                                           |
| `asset.missing`     | `to`, `name`                                                                                             | Owner answers that an asset does not exist.                                                                                                                                                                                             |
| `stream.begin`      | `to`, `stream`, `kind: snapshot\|asset`, `size`, `name?`, `mime?`                                        | Owner only. `name` is required for assets.                                                                                                                                                                                              |
| _(binary chunk)_    | see below                                                                                                | Owner only.                                                                                                                                                                                                                             |
| _(binary presence)_ | see below                                                                                                | Synced members only. Low priority, latest-only.                                                                                                                                                                                         |
| `stream.end`        | `to`, `stream`                                                                                           | Must follow exactly `size` bytes.                                                                                                                                                                                                       |
| `stream.abort`      | `to`, `stream`, `reason?`                                                                                |                                                                                                                                                                                                                                         |

Object ids: 1–64 chars of `[A-Za-z0-9_.:-]`, max 4096 per message. Room ids: 16 chars base64url.
Edit kinds: `transform`, `geometry`, `property`, `texture`, `reparent`, `delete`, `create`;
max 256 ops per edit; `d` is opaque JSON (max depth 32, max 200k nodes) relayed verbatim.

### Server → client

| Type                                                                                                                     | Fields                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `welcome`, `pong`, `room.list`, `room.created`, `room.joined`, `room.left {reason}`                                      | replies                                                        |
| `room.subscribed {rooms, intervalMs}`, `room.unsubscribed`                                                               | replies to `room.subscribe` / `room.unsubscribe`               |
| `room.list.update {rooms, removed}`                                                                                      | live list: new or changed entries, removed room ids            |
| `member.joined {user, name, color}`, `member.left {user}`                                                                | membership                                                     |
| `chat {id, from, name, color, text, at}`                                                                                 | chat message of another member                                 |
| `locks {by, add?, remove?}`                                                                                              | lock changes of another user                                   |
| `lock.result`                                                                                                            | reply to `lock.acquire` / `lock.release`                       |
| `edits {list:[{from, seq, ops}]}`                                                                                        | relayed edits, in order per sender                             |
| `edit.rejected {seq, reason, ids, why?}`                                                                                 | `not_locked`, `lock_conflict`, `lock_limit`, `lock_unverified` |
| `verify {q, ids, anc}`                                                                                                   | owner only: confirm a member's claim, answer `verify.result`   |
| `snapshot.request {for}`                                                                                                 | owner only: send the world to user `for`                       |
| `stream.begin {from, stream, kind, size, name?, mime?}`, binary chunks, `stream.end {from, stream}`, `stream.abort {from | to, stream, reason}`                                           | streams |
| `stream.credit {to, stream, delivered}`                                                                                  | owner only: bytes of a stream handed to the recipient          |
| `asset.request {from, name}` (owner), `asset.missing {from, name}`                                                       | assets                                                         |
| `room.closed {reason:'owner_left', offline:true, message}`                                                               | the owner left: you are now offline, save locally              |
| `error {code, r?, ...}`                                                                                                  | see error codes                                                |

`displayName` on create and join replaces the hello name for this room; an invalid one is rejected with
`invalid_name {reason, field: "displayName"}`. `color` is a color slot: the lowest slot no current member
of the room holds (owner 0), freed when the member leaves. Clients map slots to colors.

Error codes: `not_in_room`, `not_synced`, `not_owner`, `already_in_room`, `busy`, `invalid_name`,
`password_required`, `password_not_allowed`, `weak_password {issues}`, `wrong_password`,
`too_many_attempts`, `room_not_found`, `room_full`, `room_limit_ip`, `room_limit_server`,
`internal_test_forbidden`, `stream_invalid {detail}`, `name_locked`, `invalid_chat {reason}`
(`empty`, `too_long`, `too_many_lines`), `chat_rate_limited {retryAfterMs}`.

Display names are unique per room: a joiner whose name (compared NFKC-normalized and case-insensitively)
is already used gets the lowest free number appended (`Henry`, `Henry2`, `Henry3`, ...), shortening the
name so it stays within 12 characters. The final name comes back in `room.joined.name` and is used in
`member.joined`, member lists and chat. It stays fixed until the member leaves.

### Chat

`chat {text}` sends one message to the room. The relay normalizes the text with `chatTextNormalize`
(`src/shared/chat_text_policy.ts`, shared with the client): NFC, `\r\n`/`\r`/U+2028/U+2029 become `\n`,
control characters other than `\n`, bidi and other format characters (zero width spaces, overrides,
isolates, tags), private-use and lone surrogate code points and blank-looking fillers are removed, a zero
width joiner survives only between emoji, combining marks are capped at 4 per character, tabs become
spaces, trailing spaces and runs of blank lines are trimmed. The result must be non-empty, at most
`chatTextLength` (2000) code points and at most `chatTextLines` (20) lines, else `invalid_chat {reason}`.
Each session may send one message per `chatIntervalMs` (5 s); a faster one gets
`chat_rate_limited {retryAfterMs}` and does not count. Members get `{id, from, name, color, text, at}`:
`id` grows per room, `at` is the relay clock (epoch ms). The relay keeps no history: a message reaches
only the members in the room when it was sent, and leaving drops anything still waiting. Delivery has
lower priority than edits and streams: each recipient keeps a FIFO of at most `chatPendingPerRecipient`
(64) messages that drains only while its outbound queue is empty (ahead of presence); when a slow
recipient falls further behind, its oldest waiting message is dropped. Clients must render chat as
plain text only (no HTML, markdown or links).

Close codes: `4001` protocol violation, `4002` rate limited, `4003` handshake timeout,
`4004` slow consumer (outbound queue overflow), `4005` reserved, `4006` shutting down.
Connection-limit rejections happen at the upgrade as HTTP 429 (403 for Origin/secret).
`1009` is used by Bun for frames above the payload limit.

### Binary stream chunk

```
offset 0  u8   magic 0xA7
offset 1  u8   kind  1 (stream chunk)
offset 2  u16  reserved, must be 0
offset 4  u32  stream id (big endian, != 0)
offset 8  u32  peer user id (big endian): recipient when sent by the owner, sender when relayed
offset 12 ...  payload (1..256 KiB)
```

`src/shared/binary_frame.ts` has `binaryFrameEncode`, `binaryFrameParse`, `binaryFramePayload`.

### Binary presence

Viewport cameras and the play-mode character of a member, for drawing remote users. Shared codec:
`src/shared/presence_frame.ts` (`presenceFrameEncode`, `presenceFrameCheck`, `presenceFrameRelay`,
`presenceFrameDecode`).

```
client → relay: [0xA7][kind 2][version 1][count 0..6][entries]
relay → client: [0xA7][kind 2][version 1][count][sender u32 BE][entries]
entry (18 B):   [id u8: camera 0..15 | 0xFF character][x y z float32 BE]
                [orientation u32: smallest-three quaternion, 2 + 3×10 bits][fov u8: 1..179, 0 for the character]
```

A count of 0 clears the sender's presence. One camera is 22 bytes up and 26 bytes down (plus WebSocket
framing). The length must match the count exactly, ids must be unique and positions finite and within
±10^6; anything else closes the connection with `4001`. Each member may send 10 presence frames per second
(burst 20); excess frames and frames from members that are not synced are dropped silently.
`welcome.limits.presencePerSecond` advertises presence support: clients must not send presence frames to a relay
that leaves it out, because older relays close the connection on an unknown binary frame kind.

The relay keeps one mailbox slot per sender per recipient: a newer frame replaces an undelivered older
one, and the mailbox is delivered only while the recipient's outbound queue is empty and its socket
buffer is below 64 KiB. Presence therefore never delays edits or streams and never builds a backlog. The
latest frame of every member is handed to a joiner once its snapshot is complete. A member's presence
is forgotten when it leaves; clients drop it on `member.left`.

### Flow control

The owner may have at most `streamWindowBytes` (4 MiB) of a stream sent but not yet
credited; exceeding it aborts the stream. `stream.credit.delivered` is cumulative and
arrives at least every 256 KiB and when the stream is fully delivered. Up to 8 concurrent
streams per recipient. Snapshot ≤ 256 MiB, asset ≤ 64 MiB.

### Joining and the snapshot ordering rule

1. Joiner sends `room.join` → gets `room.joined` (members + current locks), others get `member.joined`,
   the owner gets `snapshot.request {for}`.
2. The owner serializes the world **and sends `stream.begin` synchronously, without applying new
   local edits in between**, then streams the bytes and `stream.end`.
3. The server drops the owner's own edits to the joiner until that `stream.begin` arrives (they
   are in the snapshot). Edits from other members are always delivered.
4. The joiner **buffers every `edits` frame received before `stream.end` of the snapshot** and
   applies them in order after loading the snapshot.
5. After `stream.end` the joiner is synced and may lock and edit; before that `lock.acquire` and
   `edit` answer `not_synced`. If no snapshot completes within 60 s, or the owner aborts it, the
   joiner is removed (`room.left {reason:'snapshot_timeout'|'snapshot_failed'}`).

Assets (textures etc.) are then fetched on demand: member `asset.request` → owner streams
`kind:'asset'` (or `asset.missing`). The owner may also push assets unasked.

### Locks and edit rules

- A lock is exclusive per object id; `lock.acquire` is atomic (all or nothing) and the rejection
  lists the conflicting ids and their holders. Deselecting = `lock.release` (or `lock.acquire` with `replace`).
- All locks of a user are released on leave/disconnect and broadcast as `locks {by, remove}`.
- `transform`, `geometry`, `property`, `texture`, `reparent`, `delete` require the sender to hold
  every id in the op (for `reparent`: the moved ids; include descendants for `delete`).
- `create` requires that nobody else holds the new ids; afterwards the creator holds them.
- Ids created earlier in the same `edit` count as held. Each `edit` is validated as a whole.
- After a relayed `delete` the deleted ids' locks are released.
- The owner follows the same lock rules.

### Hierarchical (shared) locks

The relay does not know the scene hierarchy, so the editor sends it: a selection locks every
selected object with its whole subtree exclusively (`ids`) and the ancestors of each selected
object as `shared`. Several members may share an id (siblings stay editable side by side), but
an exclusive request is refused while another member shares the id (conflict entry
`{id, by, shared:true}`, meaning `by` edits something inside it) and a shared request is refused
while another member holds the id exclusively. `replace:true` replaces both kinds; release, leave
and disconnect free both; both count against the lock limits. `locks` broadcasts and `room.joined`
list exclusive locks only.

`create` and `reparent` ops may carry `p`, the new parent chain (parent first). The edit is
rejected with `lock_conflict` when another member holds any of those ids exclusively (ids created
earlier in the same edit excepted); otherwise the sender gets shared locks on the chain, so nobody
can grab the new container from a stale view. Ops without `p` keep the old behaviour.

### Owner verification

The owner's editor is the source of truth for the hierarchy, so a member cannot make up ancestors
to block containers it is not inside. Whenever a member's `lock.acquire` or `edit` would give it
shared locks it does not already hold, the relay first sends the owner
`verify {q, ids, anc}`. The owner answers `verify.result {q, v}`: `ok` when every id in `ids`
exists and every id in `anc` is an ancestor of at least one of them, `deleted` when an id is
unknown, `invalid` otherwise. For `lock.acquire`, `ids` are the requested ids and `anc` the new
shared ids. For `edit`, `ids` are the first ids of the parent chains and `anc` the rest; a chain
whose first id is created earlier in the same edit must continue with that create's own chain
and is checked by the relay alone (otherwise `invalid` without asking).

- The owner's own requests and requests whose shared ids the member already holds are never
  verified: ancestors a member shares were already confirmed, so they act as the cache and the
  relay keeps no copy of the hierarchy.
- Conflicts are checked before asking. Anything other than `ok` refuses the request:
  `lock.result {ok:false, code:'lock_unverified', why}` or `edit.rejected {reason:'lock_unverified', ids:[], why}`
  with `why` = `invalid`, `deleted`, `owner_timeout` (no answer within 5 s), `owner_left` or
  `rate_limited`. After an `ok` the request is checked against the locks again and applied.
- Each member has at most one open query. Its later `lock.acquire`, `lock.release` and `edit`
  messages wait behind it in order (at most 64 messages / 4 MiB, more closes 4002).
- Queries are limited to 10/s (burst 20) per member and 50/s (burst 100) per room. The relay
  counts refuted claims per connection (for a future kick rule).
- An answer can be one owner round trip stale; a reparent in flight can only make a true claim
  look false (the member retries) or confirm an ancestor that was just moved away, which blocks
  nothing more than an honest selection made a moment earlier would have.

### Owner disconnect / offline sessions

When the owner disconnects or leaves, every member gets
`room.closed {reason:'owner_left', offline:true, message}` and the room is removed. The client must
warn the user that they are offline and should save locally. Re-joining any room requires
`discardLocalWork:true`, i.e. the client must discard the local project first (it is an online project).

## Passwords

- Policy (`src/shared/password_policy.ts`, shared with the client): 8–128 chars, at least one
  uppercase, one digit, one special character, plus heuristics: no runs of 4+ identical chars or
  a char making up >50 %, no 4+ sequences (`abcd`, `1234`, `4321`) or keyboard runs (QWERTY/QWERTZ/AZERTY rows),
  ≥5 distinct chars, no common passwords even with leetspeak (`P@ssw0rd1!`), and an entropy estimate ≥40 bits.
  `passwordPolicyEvaluate(pw)` returns `{ok, issues[], estimatedBits}` for UI feedback.
- Generator (`src/shared/password_generator.ts`): `passwordGenerate(16)` uses `crypto.getRandomValues`
  with rejection sampling, unambiguous alphabets, guarantees each class, and always passes the policy.
  Use it to prefill the private room password field.
- The server stores only argon2id hashes (`Bun.password`, 19 MiB, t=2), verifies in constant time,
  at most 4 hash operations concurrently and 1 per IP (IPv6 per /64), and limits wrong passwords to
  10/min per IP and 30/min per room.

## Abuse resistance and limits

| Limit            | Default                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Max frame        | 1 MiB (binary chunk payload 256 KiB)                                                                  |
| Messages         | 120/s, burst 400 → close 4002                                                                         |
| Bytes in         | 16 MiB/s, burst 32 MiB → close 4002                                                                   |
| Connections      | 24 per IP (IPv6 per /64), 2000 total                                                                  |
| Rooms            | 8 owned per IP, 500 total; 1 room per connection                                                      |
| Room entries     | create + join 30/min per IP (burst 10) → error `too_many_attempts`                                    |
| Users per room   | 16 default, max 32                                                                                    |
| Locks            | 20 000 per user, 100 000 per room, 400 000 per relay                                                  |
| Outbound queue   | 16 MiB per recipient, 256 MiB backlog (queue + socket buffer) across all → close 4004 (slow consumer) |
| Handshake / idle | 5 s / 60 s (with ping/pong)                                                                           |
| Snapshot / asset | 256 MiB / 64 MiB, 4 MiB window, 8 streams per recipient, 60 s snapshot timeout                        |
| Room list        | 200 entries                                                                                           |
| Room list pushes | 1000 subscribers, at most one update per 500 ms per subscriber, low priority                          |
| Presence         | 10 frames/s per member (burst 20), latest-only per sender per recipient, 116 bytes max                |
| Chat             | 1 message per 5 s per session, 2000 code points, 20 lines, 64 waiting per recipient, no history       |
| Owner verify     | 5 s timeout, 10/s (burst 20) per member, 50/s (burst 100) per room, 64 msgs / 4 MiB held per member   |

Other measures: versioned hello handshake; strict schemas; only allowed `Origin`s
(`https://henry00is.github.io`, `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`,
`views://main_ui`; override with `ALLOWED_ORIGINS`); only `/ws` upgrades; no compression
(no zip bombs, low CPU); only the owner can stream and only to members of its room; a joiner
receives only a snapshot it was promised. The relay can't be used as a general pipe: every text
frame must be a known AiWorldEd message and binary frames must belong to an open, size-declared stream
or be a well-formed presence frame from a synced room member.

### Proxy trust model

- **No `X-Forwarded-Secret`**: direct connection. The socket address is used; `X-Real-IP` /
  `X-Forwarded-For` are ignored (they could be spoofed).
- **Correct secret** (sha256 + `timingSafeEqual`): proxied. Client IP = `X-Real-IP`, else the last
  `X-Forwarded-For` hop, else the socket address. `welcome.via = "proxy"`.
- **Wrong or empty secret, or a secret while none is configured**: the upgrade is refused with 403.
  A wrong secret means someone is impersonating the proxy, so it is neither trusted nor treated as direct.

### Internal test rooms

`room.create {internalTest:true}` is accepted only on direct connections (no `X-Forwarded-Secret`),
i.e. local tests. Such rooms are hidden from proxied clients' room lists and cannot be joined through
the proxy (`room_not_found`). Proxied creation attempts get `internal_test_forbidden`. Set
`INTERNAL_TEST_ROOMS=false` to disable them. `INTERNAL_TEST_ROOMS_VIA_PROXY=true`
also allows them through the proxy, for test suites against a private development relay; it defaults
to off and must never be set on a public relay. Tests use the dummy secret in
`tests/support/test_configuration.ts`; the real secret is never in this repository.

## Configuration (environment)

| Variable                                                    | Meaning                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `HOST`, `PORT`                                              | Listen address (container: `0.0.0.0:8081`)                                                       |
| `FORWARDED_SECRET`                                          | Secret the reverse proxy sends as `X-Forwarded-Secret` (≥16 chars). Without it, proxied requests are refused. |
| `WEBSOCKET_PATH`                                            | WebSocket path (default `/ws`)  |
| `ALLOWED_ORIGINS`                                           | Comma-separated Origin allow list                                                                |
| `INTERNAL_TEST_ROOMS`                                       | `false` disables internal test rooms                                                             |
| `INTERNAL_TEST_ROOMS_VIA_PROXY`                             | dev relay only: `true` allows internal test rooms through the proxy (default off)                |
| `CONNECTIONS_PER_IP`, `ROOMS_PER_IP`                        | dev relay only: raise the per-IP limits (defaults 24 and 8)                                      |
| `ROOM_ENTRIES_PER_IP_PER_MINUTE`, `ROOM_ENTRY_BURST_PER_IP` | dev relay only: raise the room create/join rate per IP (defaults 30/min and 10)                  |
| `BIND_ADDRESS`                                              | compose only: host address to publish the port on                                                |
| `CONTAINER_NAME`, `IMAGE_TAG`                               | compose only: dev instance names (defaults `aiworlded-server`, `latest`)                         |

## Deployment

`compose.yaml` runs the relay in Docker behind a TLS-terminating reverse proxy. Secrets come
from `./.env` (chmod 600, never committed; see `.env.example`). Publish the container port only
on a private interface the proxy can reach, and let the proxy forward only the WebSocket path.

### Live room list

While a client's room browser is open it sends `room.subscribe`; it sends `room.unsubscribe` when the
browser closes (a dropped socket unsubscribes too). Any change to the list (room created or closed,
member count changed) marks every subscriber dirty. Each subscriber then gets one `room.list.update`
with only the entries that are new or changed and the ids that disappeared, at most once per
`roomListPushIntervalMs` (changes in between are coalesced). The list is capped at `roomListMaximum`
entries. Pushes have lower priority than edits and streams: a push is only handed to the socket when the
recipient's outbound queue is empty and its socket buffer is below the presence high water mark;
otherwise it waits another interval and is recomputed. Internal test rooms are never pushed to proxied
subscribers, even when `INTERNAL_TEST_ROOMS_VIA_PROXY` is set.

## Client integration checklist (AiWorldEd)

- Copy or import `src/shared/*` (protocol constants/types, binary frames, presence frames, password policy + generator, name rules).
- Connect to `wss://aiworlded.00labs.net/ws` (Origin must be allowed), send `hello`, read `welcome.limits`.
- Room browser: `room.subscribe` while open (`room.list` for a one-off read); create dialog with name (≤128) and private toggle; prefill the password with
  `passwordGenerate()` and show `passwordPolicyEvaluate()` issues live.
- Joining: confirm "discard local work", send `room.join {discardLocalWork:true}`, load the snapshot
  stream, buffer `edits` until snapshot `stream.end`, then apply them.
- Owner: answer `snapshot.request` (serialize + `stream.begin` synchronously), stream chunks respecting
  `stream.credit`; answer `asset.request` with an asset stream or `asset.missing`.
- Selection → `lock.acquire {replace:true}`; on `lock_conflict` show who holds what; deselect → `lock.release`.
  Render `locks` events as remote selections.
- Owner: answer every `verify` with `verify.result` from the live scene. Members: on `lock_unverified` retry
  briefly, then tell the user the owner did not confirm.
- Send edits batched per frame/operation with increasing `seq`; handle `edit.rejected` by reverting locally.
- On `room.closed {offline:true}` show the offline warning and offer "save locally".
- Handle close codes (4002 back off, 4004 reconnect & rejoin, 4006 server restart).
