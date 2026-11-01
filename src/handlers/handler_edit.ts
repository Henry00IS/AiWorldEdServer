/**
 * Edit validation and relay. One-shot edits need no lock (last writer wins in
 * relay order) and are refused only where another member runs an operation;
 * edits of a running operation must stay inside its lease. Every accepted edit
 * is acknowledged to its sender inside the same ordered edit stream, so a
 * client knows exactly which remote edits came before its own.
 */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import type { Room } from '../rooms/room.ts';
import { roomBroadcastLocks } from '../rooms/room_broadcast.ts';
import type { ServerCore } from '../server/server_core.ts';
import type { ClientMessage, EditOperation, VerifyDenial } from '../shared/protocol_definitions.ts';
import { abuseRecord, abuseThrottled } from './handler_abuse.ts';
import { editLockCheck, type EditLockPlan, type EditRejection } from './handler_edit_rules.ts';
import { sessionSyncedRoom } from './handler_lock.ts';
import { verifyAsk, verifyNeeded, type VerifyClaim } from './handler_verify.ts';

export { editLockCheck } from './handler_edit_rules.ts';

type EditMessage = Extract<ClientMessage, { t: 'edit' }>;

/** Refusal reasons decided before the lock rules. */
type EditGateReason = 'lease_stale' | 'rate_limited' | 'throttled';

/**
 * Accepts an edit that passes the lease, rate and lock rules, relays it to the
 * other members and acknowledges it to the sender. When a member's parent
 * chains are not confirmed yet, the room owner must confirm them first.
 *
 * @param core Relay core.
 * @param session Sender.
 * @param message Edit batch.
 */
export function handlerEdit(core: ServerCore, session: ConnectionSession, message: EditMessage): void {
  const room = sessionSyncedRoom(session, undefined);
  if (!room) return;
  const gate = editGate(core, room, session, message);
  if (gate) return editReject(session, message.seq, { reason: gate, ids: [] }, null);
  const plan = editPlan(core, room, session, message);
  if (plan === null) return;
  if (!verifyNeeded(room, session, plan.shared)) return editAccept(room, session, message, plan);
  const claim = editClaim(message.ops);
  if (claim === null) return editReject(session, message.seq, { reason: 'lock_unverified', ids: [] }, 'invalid');
  verifyAsk(core, room, session, claim, (outcome) => {
    if (outcome !== 'ok') return editReject(session, message.seq, { reason: 'lock_unverified', ids: [] }, outcome);
    if (session.room !== room || !session.synced) return;
    if (message.lease !== undefined && room.locks.leases.of(session.user)?.id !== message.lease)
      return editReject(session, message.seq, { reason: 'lease_stale', ids: [] }, null);
    const recheckedPlan = editPlan(core, room, session, message);
    if (recheckedPlan !== null) editAccept(room, session, message, recheckedPlan);
  });
}

/**
 * Applies throttling, the lease tag and the rate limits.
 *
 * @param core Relay core.
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @returns Refusal reason, or null.
 */
function editGate(
  core: ServerCore,
  room: Room,
  session: ConnectionSession,
  message: EditMessage,
): EditGateReason | null {
  if (abuseThrottled(core, session)) {
    abuseRecord(core, session, 1, 'edit while throttled');
    return 'throttled';
  }
  const running = room.locks.leases.of(session.user);
  if (message.lease !== undefined && running?.id !== message.lease) {
    const neverIssued = message.lease > room.locks.leases.lastId(session.user);
    abuseRecord(core, session, neverIssued ? 1 : 0, 'edit with a lease never issued');
    return 'lease_stale';
  }
  if (editRateAllowed(room, session, message, running !== undefined)) return null;
  abuseRecord(core, session, 1, 'edit flood');
  return 'rate_limited';
}

/**
 * Takes the rate tokens of an edit: live previews of a running operation use
 * the live bucket, anything else the member's and the room's one-shot buckets;
 * created and deleted ids also take from the bulk bucket.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @param leased Whether the sender runs an operation.
 * @returns True when the edit is within the limits.
 */
function editRateAllowed(room: Room, session: ConnectionSession, message: EditMessage, leased: boolean): boolean {
  const { limits } = session;
  const bulk = editBulkCount(message.ops);
  if (bulk > 0 && !limits.bulkIdsBucket.take(bulk)) return false;
  if (leased) return limits.liveBucket.take();
  return limits.oneShotBucket.take() && room.oneShotBucket.take();
}

/**
 * Counts the ids an edit creates or deletes.
 *
 * @param operations Operations of the batch.
 * @returns Number of created plus deleted ids.
 */
function editBulkCount(operations: readonly EditOperation[]): number {
  let count = 0;
  for (const operation of operations)
    if (operation.k === 'create' || operation.k === 'delete') count += operation.ids.length;
  return count;
}

/**
 * Checks an edit against the lock rules and refuses it when it does not pass.
 * Edits outside the sender's own running operation count as misuse.
 *
 * @param core Relay core.
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @returns Lock effects, or null when the edit was refused.
 */
function editPlan(core: ServerCore, room: Room, session: ConnectionSession, message: EditMessage): EditLockPlan | null {
  const plan: EditLockPlan = { created: [], deleted: [], shared: [] };
  const rejection = editLockCheck(room, session.user, message.ops, plan);
  if (rejection === null) return plan;
  if (rejection.reason === 'outside_lease') abuseRecord(core, session, 1, 'edit outside the running operation');
  editReject(session, message.seq, rejection, null);
  return null;
}

/**
 * Relays an accepted edit, acknowledges it and applies its lock effects:
 * objects created during an operation join its lease, deleted objects leave the
 * sender's locks and the operation counts as progressing.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 * @param plan Lock effects.
 */
function editAccept(room: Room, session: ConnectionSession, message: EditMessage, plan: EditLockPlan): void {
  editRelay(room, session, message);
  const leased = room.locks.leases.of(session.user) !== undefined;
  const added = leased ? plan.created : [];
  room.locks.grant(session.user, added);
  const lease = room.locks.leases.of(session.user);
  const released = room.locks.release(session.user, plan.deleted);
  if (lease !== undefined && room.locks.leases.of(session.user) === undefined)
    room.locks.leases.adopt(session.user, lease);
  room.locks.leases.progress(session.user);
  roomBroadcastLocks(room, session, added, released);
}

/**
 * Tells the sender its edit was refused.
 *
 * @param session Sender.
 * @param seq Sequence number of the edit.
 * @param rejection Reason and ids.
 * @param why Why the owner did not confirm, for `lock_unverified`.
 */
function editReject(session: ConnectionSession, seq: number, rejection: EditRejection, why: VerifyDenial | null): void {
  sessionSend(session, {
    t: 'edit.rejected',
    seq,
    reason: rejection.reason,
    ids: rejection.ids.slice(0, 64),
    ...(why === null ? {} : { why }),
  });
}

/**
 * Builds the owner query for the parent chains of an edit: each chain's first
 * id must exist and the rest must be its ancestors. A chain whose parent is
 * created earlier in the same batch must continue with that create's own chain,
 * which is checked here without asking the owner.
 *
 * @param operations Operations of the batch.
 * @returns Claim, or null when a chain contradicts the batch itself.
 */
export function editClaim(operations: readonly EditOperation[]): VerifyClaim | null {
  const chainOfCreated = new Map<string, readonly string[]>();
  const heads = new Set<string>();
  const ancestors = new Set<string>();
  for (const operation of operations) {
    const chain = operation.k === 'create' || operation.k === 'reparent' ? (operation.p ?? []) : [];
    const [head, ...rest] = chain;
    if (head !== undefined && chainOfCreated.has(head)) {
      if (!editChainSame(rest, chainOfCreated.get(head) ?? [])) return null;
    } else if (head !== undefined) {
      heads.add(head);
      rest.forEach((id) => ancestors.add(id));
    }
    if (operation.k === 'create') operation.ids.forEach((id) => chainOfCreated.set(id, chain));
  }
  return { ids: [...heads], anc: [...ancestors] };
}

/**
 * Compares two parent chains.
 *
 * @param left Chain.
 * @param right Chain.
 * @returns True when both list the same ids in the same order.
 */
function editChainSame(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Serializes the edit entry once and queues it for each other member, plus a
 * bare acknowledgement for the sender in the same ordered stream. Edits from
 * the owner are skipped for members whose snapshot has not begun yet, because
 * the snapshot will already contain them.
 *
 * @param room Room.
 * @param session Sender.
 * @param message Edit batch.
 */
function editRelay(room: Room, session: ConnectionSession, message: EditMessage): void {
  const entry = JSON.stringify({ from: session.user, seq: message.seq, ops: message.ops });
  const fromOwner = session === room.owner;
  for (const member of room.members.values()) {
    if (member === session || member.closed) continue;
    if (fromOwner && member.awaitingSnapshotBegin) continue;
    member.outbound.pushEdit(entry);
  }
  session.outbound.pushEdit(JSON.stringify({ from: session.user, seq: message.seq }));
}
