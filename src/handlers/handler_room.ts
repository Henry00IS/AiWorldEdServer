/** Room list, create, join and leave, plus membership teardown. */
import type { CompatibilityDecision } from '../shared/compatibility_identity.ts';
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import { protocolMismatchMessage } from '../shared/protocol_versioning.ts';
import { Room, type RoomOptions } from '../rooms/room.ts';
import { roomBroadcast, roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import { passwordPolicyEvaluate } from '../shared/password_policy.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { displayNameNormalize, displayNameUnique, roomNameNormalize } from '../shared/room_name_policy.ts';
import { chatPurge } from './handler_chat.ts';
import { typingClear, typingClearAll } from './handler_typing.ts';
import { presencePurge } from './handler_presence.ts';
import { verifyCancel } from './handler_verify.ts';

type RoomCreateMessage = Extract<ClientMessage, { t: 'room.create' }>;
type RoomJoinMessage = Extract<ClientMessage, { t: 'room.join' }>;

/**
 * Argon2id parameters (OWASP minimum: 19 MiB, 2 iterations) keep hashing cheap
 * enough for a small server.
 */
export const PASSWORD_HASH_OPTIONS = { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 } as const;

/** Text sent to members when the owner leaves. */
export const OFFLINE_SESSION_MESSAGE =
  'The room owner disconnected. You are now working offline: save your changes locally. Re-joining a room discards local work.';

/**
 * Returns whether a session may create, list and join internal test rooms:
 * direct connections always, proxied ones only when the relay is configured
 * with INTERNAL_TEST_ROOMS_VIA_PROXY (development relay only).
 *
 * @param core Relay core.
 * @param session Requester.
 * @returns True when internal test rooms are accessible to the session.
 */
export function internalTestRoomsAccessible(core: ServerCore, session: ConnectionSession): boolean {
  return session.via === 'direct' || core.config.internalTestRoomsViaProxy;
}

/**
 * Replies with the visible rooms. Internal test rooms are only visible to
 * sessions for which {@link internalTestRoomsAccessible} holds.
 *
 * @param core Relay core.
 * @param session Requester.
 * @param message Request.
 */
export function handlerRoomList(core: ServerCore, session: ConnectionSession, message: { r?: number }): void {
  const rooms = [];
  for (const room of core.registry.all()) {
    if (rooms.length >= core.config.roomListMaximum) break;
    if (room.internalTest && !internalTestRoomsAccessible(core, session)) continue;
    rooms.push(room.describe());
  }
  sessionSend(session, { t: 'room.list', r: message.r, rooms });
}

/**
 * Validates and creates a room owned by the sender.
 *
 * @param core Relay core.
 * @param session Creator.
 * @param message Request.
 */
export async function handlerRoomCreate(
  core: ServerCore,
  session: ConnectionSession,
  message: RoomCreateMessage,
): Promise<void> {
  const rejection = roomCreateRejection(core, session, message);
  if (rejection) return sessionSendError(session, rejection.code, message.r, rejection.details);
  const reservation = core.registry.reserve(session.ipKey);
  if (reservation !== 'ok') return sessionSendError(session, reservation, message.r);
  const passwordHash = message.private ? await passwordHashGuarded(core, session, message.password ?? '') : null;
  if (session.closed || session.room || (message.private && passwordHash === null)) {
    core.registry.reservationCancel(session.ipKey);
    if (message.private && passwordHash === null && !session.closed) sessionSendError(session, 'busy', message.r);
    return;
  }
  roomCreateCommit(core, session, message, passwordHash);
}

/**
 * Creates the reserved room, makes the creator its synced owner and confirms
 * the creation.
 *
 * @param core Relay core.
 * @param session Creator.
 * @param message Validated request.
 * @param passwordHash Password hash of a private room, or null.
 */
function roomCreateCommit(
  core: ServerCore,
  session: ConnectionSession,
  message: RoomCreateMessage,
  passwordHash: string | null,
): void {
  sessionDisplayNameApply(session, message.displayName);
  const room = roomInstantiate(core, session, message, passwordHash);
  core.registry.reservationCommit(room);
  session.room = room;
  session.synced = true;
  core.roomListSubscriptions.changed();
  sessionSend(session, {
    t: 'room.created',
    r: message.r,
    room: room.describe(),
    you: session.user,
    name: session.name,
    color: room.colorOf(session.user),
  });
}

/**
 * Checks a room creation request against the session state, name rules,
 * test-room rules and password policy.
 *
 * @param core Relay core.
 * @param session Creator.
 * @param message Request.
 * @returns Null when acceptable, otherwise the error code and details.
 */
function roomCreateRejection(
  core: ServerCore,
  session: ConnectionSession,
  message: RoomCreateMessage,
): { code: string; details?: object } | null {
  if (session.room) return { code: 'already_in_room' };
  if (session.pendingAsyncOperation) return { code: 'busy' };
  if (!core.roomEntriesPerIpKey.take(session.ipKey)) return { code: 'too_many_attempts' };
  const name = roomNameNormalize(message.name);
  if (!name.ok) return { code: 'invalid_name', details: { reason: name.reason } };
  const displayName = displayNameRejection(message.displayName);
  if (displayName) return displayName;
  if (message.internalTest && (!internalTestRoomsAccessible(core, session) || !core.config.internalTestRoomsEnabled))
    return { code: 'internal_test_forbidden' };
  if (!message.private) return message.password === undefined ? null : { code: 'password_not_allowed' };
  if (message.password === undefined) return { code: 'password_required' };
  const policy = passwordPolicyEvaluate(message.password);
  return policy.ok ? null : { code: 'weak_password', details: { issues: policy.issues } };
}

/**
 * Creates the room object for a validated creation request.
 *
 * @param core Relay core.
 * @param session Owner.
 * @param message Validated request.
 * @param passwordHash Argon2id hash or null for public rooms.
 * @returns New room.
 */
function roomInstantiate(
  core: ServerCore,
  session: ConnectionSession,
  message: RoomCreateMessage,
  passwordHash: string | null,
): Room {
  const name = roomNameNormalize(message.name);
  return new Room({
    id: roomIdGenerateUnique(core),
    name: name.ok ? name.name : '',
    isPrivate: message.private,
    editMode: message.editMode ?? 'viewers',
    passwordHash,
    internalTest: message.internalTest === true,
    maxUsers: Math.min(message.maxUsers ?? core.config.usersPerRoomDefault, core.config.usersPerRoomMaximum),
    owner: session,
    ...roomEditOptions(core),
  });
}

/**
 * Lists the lock, verification, lease and one-shot edit limits of new rooms.
 *
 * @param core Relay core.
 * @returns Room option fields.
 */
function roomEditOptions(core: ServerCore): Pick<RoomOptions, 'locksPerUser' | 'locksPerRoom'> & Partial<RoomOptions> {
  const config = core.config;
  return {
    locksPerUser: config.locksPerUser,
    locksPerRoom: config.locksPerRoom,
    verifyPerSecond: config.verifyPerRoomPerSecond,
    verifyBurst: config.verifyPerRoomBurst,
    leaseTimings: {
      leaseMs: config.lockLeaseMs,
      idleMaximumMs: config.lockLeaseIdleMaximumMs,
      totalMaximumMs: config.lockLeaseTotalMaximumMs,
    },
    oneShotPerSecond: config.oneShotEditsPerRoomPerSecond,
    oneShotBurst: config.oneShotEditRoomBurst,
  };
}

/**
 * Generates a random room id that no live room uses.
 *
 * @param core Relay core.
 * @returns A random 16 character base64url id not in use.
 */
function roomIdGenerateUnique(core: ServerCore): string {
  for (;;) {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
    if (!core.registry.get(id)) return id;
  }
}

/**
 * Hashes a password with a global concurrency cap.
 *
 * @param core Relay core.
 * @param session Requester (marked busy meanwhile).
 * @param password Plain password.
 * @returns Hash, or null when the server is busy.
 */
async function passwordHashGuarded(
  core: ServerCore,
  session: ConnectionSession,
  password: string,
): Promise<string | null> {
  return passwordWorkGuarded(core, session, () => Bun.password.hash(password, PASSWORD_HASH_OPTIONS));
}

/**
 * Runs password work under the global and per-address concurrency caps and the
 * per-session busy flag, so one address cannot occupy every hashing slot.
 *
 * @param core Relay core.
 * @param session Requester.
 * @param work Async password operation.
 * @returns Work result, or null when the cap was reached.
 */
async function passwordWorkGuarded<T>(
  core: ServerCore,
  session: ConnectionSession,
  work: () => Promise<T>,
): Promise<T | null> {
  if (core.passwordHashesInFlight >= core.config.passwordHashConcurrency) return null;
  if (!core.passwordWorkPerIpKey.tryAcquire(session.ipKey)) return null;
  core.passwordHashesInFlight++;
  session.pendingAsyncOperation = true;
  try {
    return await work();
  } finally {
    core.passwordHashesInFlight--;
    core.passwordWorkPerIpKey.release(session.ipKey);
    session.pendingAsyncOperation = false;
  }
}

/**
 * Verifies access and adds the sender to a room; asks the owner for a snapshot.
 *
 * @param core Relay core.
 * @param session Joiner.
 * @param message Request (discardLocalWork is guaranteed true by the schema).
 */
export async function handlerRoomJoin(
  core: ServerCore,
  session: ConnectionSession,
  message: RoomJoinMessage,
): Promise<void> {
  if (!core.roomEntriesPerIpKey.take(session.ipKey)) return sessionSendError(session, 'too_many_attempts', message.r);
  const room = core.registry.get(message.room);
  const rejection = roomJoinRejection(core, session, room);
  if (rejection || !room) return roomJoinRefuse(session, room, rejection ?? 'room_not_found', message.r);
  const displayName = displayNameRejection(message.displayName);
  if (displayName) return sessionSendError(session, displayName.code, message.r, displayName.details);
  if (room.passwordHash !== null) {
    const verdict = await roomJoinPasswordCheck(core, session, room, message.password);
    if (verdict !== 'ok') return verdict === 'gone' ? undefined : sessionSendError(session, verdict, message.r);
    const lateRejection = roomJoinRejection(core, session, room);
    if (lateRejection) return roomJoinRefuse(session, room, lateRejection, message.r);
  }
  if (!(await roomCompatibilityCheck(core, session, room, message))) return;
  sessionDisplayNameApply(session, message.displayName);
  roomMemberAdd(core, session, room, message.r);
}

/**
 * Waits for the owner's decision, then rechecks current room capacity/state.
 *
 * @param core Relay core.
 * @param session Pending joiner.
 * @param room Target room.
 * @param message Validated join request.
 * @returns Whether admission may commit.
 */
async function roomCompatibilityCheck(
  core: ServerCore,
  session: ConnectionSession,
  room: Room,
  message: RoomJoinMessage,
): Promise<boolean> {
  session.pendingAsyncOperation = true;
  const decision = await core.compatibility.request(
    room,
    session,
    message.compatibility,
    core.config.compatibilityTimeoutMs,
    core.config.compatibilityPendingPerRoom,
  );
  session.pendingAsyncOperation = false;
  if (session.closed) return false;
  if (!decision.allow) return roomCompatibilityRefuse(session, decision, message.r);
  const rejection = roomJoinRejection(core, session, room);
  if (rejection) roomJoinRefuse(session, room, rejection, message.r);
  return rejection === null;
}

/**
 * Reports an admission refusal without calling a timeout software
 * incompatibility.
 *
 * @param session Waiting joiner.
 * @param decision Owner decision or lifecycle refusal.
 * @param r Correlated request id.
 * @returns False, because no membership may be added.
 */
function roomCompatibilityRefuse(session: ConnectionSession, decision: CompatibilityDecision, r?: number): false {
  const reason = decision.reason ?? 'incompatible_client';
  const code = reason === 'owner_timeout' || reason === 'owner_left' ? reason : 'client_incompatible';
  sessionSendError(session, code, r, { reason, ...(decision.homeUrl ? { homeUrl: decision.homeUrl } : {}) });
  return false;
}

/**
 * Checks the optional display name of a create or join request.
 *
 * @param rawName Display name from a create or join request, if any.
 * @returns Null when absent or valid, otherwise the invalid_name error with
 *   field "displayName".
 */
function displayNameRejection(rawName: string | undefined): { code: string; details: object } | null {
  if (rawName === undefined) return null;
  const name = displayNameNormalize(rawName);
  return name.ok ? null : { code: 'invalid_name', details: { reason: name.reason, field: 'displayName' } };
}

/**
 * Adopts the display name chosen for this room, if one was sent (validated
 * beforehand).
 *
 * @param session Session entering a room.
 * @param rawName Display name from the request, if any.
 */
function sessionDisplayNameApply(session: ConnectionSession, rawName: string | undefined): void {
  const name = rawName === undefined ? null : displayNameNormalize(rawName);
  if (name?.ok) session.nameChosen = name.name;
  session.name = session.nameChosen;
}

/**
 * Checks whether a session may join a room before the password is verified.
 *
 * @param core Relay core.
 * @param session Joiner.
 * @param room Target room, if it exists.
 * @returns Error code, or null when the join may proceed.
 */
function roomJoinRejection(core: ServerCore, session: ConnectionSession, room: Room | undefined): string | null {
  if (session.room) return 'already_in_room';
  if (session.pendingAsyncOperation) return 'busy';
  if (!room || room.closed || (room.internalTest && !internalTestRoomsAccessible(core, session)))
    return 'room_not_found';
  if (room.protocol.version !== session.protocol.version) return 'protocol_mismatch';
  if (room.members.size >= room.maxUsers) return 'room_full';
  if (room.joinCoolingDown(session.ipKey, performance.now())) return 'too_many_attempts';
  return null;
}

/**
 * Sends a join refusal; a protocol mismatch also carries both versions and a
 * message the editor can show as is.
 *
 * @param session Joiner.
 * @param room Room asked for, if it exists.
 * @param code Error code.
 * @param requestId Request id to echo.
 */
function roomJoinRefuse(session: ConnectionSession, room: Room | undefined, code: string, requestId?: number): void {
  if (code !== 'protocol_mismatch' || !room) return sessionSendError(session, code, requestId);
  const roomProtocol = room.protocol.version;
  const yourProtocol = session.protocol.version;
  const message = protocolMismatchMessage(roomProtocol, yourProtocol);
  sessionSendError(session, code, requestId, { roomProtocol, yourProtocol, message });
}

/**
 * Rate-limited, constant-time password verification.
 *
 * @param core Relay core.
 * @param session Joiner.
 * @param room Private room.
 * @param password Supplied password.
 * @returns 'ok', 'gone' when the session closed meanwhile, or an error code.
 */
async function roomJoinPasswordCheck(
  core: ServerCore,
  session: ConnectionSession,
  room: Room,
  password: string | undefined,
): Promise<string> {
  if (password === undefined) return 'password_required';
  if (core.joinFailuresPerIp.isBlocked(session.ipKey) || core.joinFailuresPerRoom.isBlocked(room.id))
    return 'too_many_attempts';
  const hash = room.passwordHash ?? '';
  const matches = await passwordWorkGuarded(core, session, () => Bun.password.verify(password, hash));
  if (session.closed) return 'gone';
  if (matches === null) return 'busy';
  if (matches) return 'ok';
  core.joinFailuresPerIp.recordFailure(session.ipKey);
  core.joinFailuresPerRoom.recordFailure(room.id);
  return 'wrong_password';
}

/**
 * Adds a verified joiner under a display name no other member uses ("Henry"
 * becomes "Henry2"), informs everyone and requests a snapshot from the owner.
 *
 * @param core Relay core.
 * @param session Joiner.
 * @param room Room.
 * @param requestId Request id to echo.
 */
function roomMemberAdd(core: ServerCore, session: ConnectionSession, room: Room, requestId: number | undefined): void {
  session.name = displayNameUnique(session.nameChosen, room.memberNameKeys());
  room.memberAdd(session);
  core.roomListSubscriptions.changed();
  session.room = room;
  session.synced = false;
  session.awaitingSnapshotBegin = true;
  session.snapshotTimer = setTimeout(
    () => roomMembershipEnd(core, session, 'snapshot_timeout'),
    core.config.snapshotTimeoutMs,
  );
  roomJoinedSend(session, room, requestId);
  roomMemberJoinedBroadcast(room, session);
  sessionSend(room.owner, { t: 'snapshot.request', for: session.user });
}

/**
 * Broadcasts a new member's name, color and edit permission.
 *
 * @param room Joined room.
 * @param session New member.
 */
function roomMemberJoinedBroadcast(room: Room, session: ConnectionSession): void {
  roomBroadcast(
    room,
    {
      t: 'member.joined',
      user: session.user,
      name: session.name,
      color: room.colorOf(session.user),
      canEdit: room.canEdit(session),
    },
    session.user,
  );
}

/**
 * Sends the join confirmation with the room, its members and its locks, and the
 * joiner's final display name and color.
 *
 * @param session Joiner.
 * @param room Joined room.
 * @param requestId Request id to echo.
 */
function roomJoinedSend(session: ConnectionSession, room: Room, requestId: number | undefined): void {
  sessionSend(session, {
    t: 'room.joined',
    r: requestId,
    room: room.describe(),
    you: session.user,
    name: session.name,
    color: room.colorOf(session.user),
    owner: room.owner.user,
    members: room.memberList(),
    locks: room.locks.listAll(),
  });
}

/**
 * Explicit leave request.
 *
 * @param core Relay core.
 * @param session Leaver.
 * @param message Request.
 */
export function handlerRoomLeave(core: ServerCore, session: ConnectionSession, message: { r?: number }): void {
  if (!session.room) return sessionSendError(session, 'not_in_room', message.r);
  roomMembershipEnd(core, session, 'left', message.r);
}

/**
 * Ends a session's room membership. An owner leaving closes the room.
 *
 * @param core Relay core.
 * @param session Leaving session.
 * @param reason Reason reported in room.left.
 * @param requestId Request id to echo, if any.
 */
export function roomMembershipEnd(
  core: ServerCore,
  session: ConnectionSession,
  reason: string,
  requestId?: number,
): void {
  const room = session.room;
  if (!room) return;
  if (room.owner === session) roomClose(core, room);
  else roomMemberRemove(room, session);
  core.roomListSubscriptions.changed();
  sessionSend(session, {
    t: 'room.left',
    reason: room.owner === session ? 'closed' : reason,
    ...(requestId === undefined ? {} : { r: requestId }),
  });
}

/**
 * Removes a non-owner member: frees locks, aborts its streams, informs the
 * room.
 *
 * Typing is cleared before the leave so the leaver cannot appear in a later
 * typing list.
 *
 * @param room Room.
 * @param session Member.
 */
function roomMemberRemove(room: Room, session: ConnectionSession): void {
  room.customLocks.release(session.user);
  verifyCancel(session, null);
  typingClear(room, session.user);
  room.memberDelete(session.user);
  presencePurge(room, session);
  sessionRoomStateReset(session);
  roomBroadcastLocks(room, session, [], room.locks.release(session.user));
  for (const stream of room.streamsRemoveFor(session.user)) {
    sessionSend(room.owner, { t: 'stream.abort', to: session.user, stream: stream.id, reason: 'recipient_left' });
  }
  roomBroadcast(room, { t: 'member.left', user: session.user });
}

/**
 * Closes a room after its owner left; members are told they are offline now.
 *
 * @param core Relay core.
 * @param room Room to close.
 */
function roomClose(core: ServerCore, room: Room): void {
  core.compatibility.cancel(room.owner);
  room.closed = true;
  core.registry.remove(room);
  typingClearAll(room);
  room.streams.clear();
  room.locks.releaseEverything();
  room.customLocks.releaseEverything();
  room.presenceLatest.clear();
  for (const member of room.members.values()) verifyCancel(member, 'owner_left');
  room.verifyWaiting.clear();
  for (const member of room.members.values()) {
    member.presencePending.clear();
    sessionRoomStateReset(member);
    if (member !== room.owner)
      sessionSend(member, { t: 'room.closed', reason: 'owner_left', offline: true, message: OFFLINE_SESSION_MESSAGE });
  }
  room.members.clear();
}

/**
 * Clears all per-room state of a session.
 *
 * @param session Session leaving its room.
 */
function sessionRoomStateReset(session: ConnectionSession): void {
  if (session.snapshotTimer) clearTimeout(session.snapshotTimer);
  session.snapshotTimer = null;
  session.room = null;
  session.synced = false;
  session.awaitingSnapshotBegin = false;
  chatPurge(session);
}
