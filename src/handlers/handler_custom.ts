/** Opaque third-party member/owner traffic and isolated custom-key locks. */
import { sessionSend, sessionSendError, type ConnectionSession } from '../connection/connection_session.ts';
import type { ServerCore } from '../server/server_core.ts';
import { customFrameParse, type CustomFrame, type CustomGuard } from '../shared/custom_frame.ts';
import { binaryFrameCopyWithPeer } from '../shared/binary_frame.ts';
import type { ClientMessage } from '../shared/protocol_definitions.ts';
import { schemaValidate } from '../protocol/schema_validator.ts';
import { CUSTOM_GUARD_SCHEMA } from '../protocol/protocol_message_schemas.ts';
import { CustomWindow } from '../forks/custom_window.ts';
import { abuseRecord, abuseThrottled } from './handler_abuse.ts';
import { editLockCheck } from './handler_edit_rules.ts';

const windows = new WeakMap<ConnectionSession, CustomWindow>();
type CustomLockMessage = Extract<ClientMessage, { t: 'custom.lock.acquire' | 'custom.lock.release' }>;

/**
 * Validates only the envelope, budget, membership and optional scene locks.
 *
 * @param core Relay core.
 * @param sender Sender.
 * @param frame Opaque binary frame.
 */
export function handlerCustom(core: ServerCore, sender: ConnectionSession, frame: Uint8Array): void {
  const parsed = customFrameParse(frame);
  if (!parsed || schemaValidate(CUSTOM_GUARD_SCHEMA, parsed.guard))
    return core.violation(sender, 'invalid custom envelope');
  const reason = customGate(core, sender, parsed);
  if (reason) return sessionSendError(sender, reason, parsed.r);
  const room = sender.room;
  if (!room) return;
  const recipients = customRecipients(sender, parsed);
  if (recipients === null) return sessionSendError(sender, 'custom_target_invalid', parsed.r);
  const relayed = binaryFrameCopyWithPeer(frame, sender.user);
  for (const recipient of recipients) recipient.outbound.pushBinary(relayed);
  sessionSend(sender, { t: 'custom.sent', r: parsed.r });
}

/**
 * Resolves owner-authorized broadcasts or one allowed direct recipient.
 *
 * @param sender Synced sender.
 * @param frame Parsed envelope.
 * @returns Recipients or null for forbidden routing.
 */
function customRecipients(sender: ConnectionSession, frame: CustomFrame): ConnectionSession[] | null {
  const room = sender.room;
  if (!room) return null;
  if ((frame.guard as CustomGuard).broadcast) {
    if (sender !== room.owner || frame.peer !== 0) return null;
    return [...room.members.values()].filter((member) => member !== sender && member.synced && !member.closed);
  }
  const recipient = sender === room.owner ? room.members.get(frame.peer) : room.owner;
  if (
    !recipient ||
    recipient === sender ||
    (sender !== room.owner && frame.peer !== 0) ||
    !recipient.synced ||
    recipient.closed
  )
    return null;
  return [recipient];
}

/**
 * Applies sender limits before routing, charging all valid frame attempts.
 *
 * @param core Relay core.
 * @param sender Sender.
 * @param frame Parsed envelope.
 * @returns Error code or null.
 */
function customGate(core: ServerCore, sender: ConnectionSession, frame: CustomFrame): string | null {
  if (frame.payload.length > core.config.customBytesPerSecond) {
    abuseRecord(core, sender, 1, 'custom oversize flood');
    return 'custom_too_large';
  }
  const window = windows.get(sender) ?? new CustomWindow();
  windows.set(sender, window);
  if (!window.take(frame.payload.length, core.config.customBytesPerSecond, core.config.customMessagesPerSecond)) {
    abuseRecord(core, sender, 1, 'custom flood');
    return 'custom_rate_limited';
  }
  if (!sender.room) return 'not_in_room';
  if (!sender.synced) return 'not_synced';
  if (abuseThrottled(core, sender)) return 'throttled';
  return customGuardCheck(sender, frame.guard as CustomGuard);
}

/**
 * Reuses edit target rules without modifying leases or saved scene state.
 *
 * @param sender Sender in a room.
 * @param guard Validated lock envelope.
 * @returns Error code or null.
 */
function customGuardCheck(sender: ConnectionSession, guard: CustomGuard): string | null {
  const room = sender.room;
  if (!room) return 'not_in_room';
  if (guard.lease !== undefined && room.locks.leases.of(sender.user)?.id !== guard.lease) return 'lease_stale';
  if (!guard.ids) return null;
  return (
    editLockCheck(room, sender.user, [{ k: 'property', ids: guard.ids }], { created: [], deleted: [], shared: [] })
      ?.reason ?? null
  );
}

/**
 * Acquires/releases opaque keys in a separate lock table with existing limits.
 *
 * @param core Relay core.
 * @param sender Synced room member.
 * @param message Validated request.
 */
export function handlerCustomLock(core: ServerCore, sender: ConnectionSession, message: CustomLockMessage): void {
  const room = sender.room;
  if (!room) return sessionSendError(sender, 'not_in_room', message.r);
  if (!sender.synced) return sessionSendError(sender, 'not_synced', message.r);
  if (abuseThrottled(core, sender)) return sessionSendError(sender, 'throttled', message.r);
  if (message.t === 'custom.lock.release') {
    const keys = room.customLocks.release(sender.user, message.keys);
    return sessionSend(sender, { t: 'custom.lock.released', r: message.r, keys });
  }
  const result = room.customLocks.acquire(sender.user, message.keys, false);
  if (!result.ok) return sessionSendError(sender, result.reason, message.r);
  sessionSend(sender, { t: 'custom.lock.acquired', r: message.r, keys: message.keys });
}

/**
 * Handles fork control messages, leaving unrelated messages to other handlers.
 *
 * @param core Relay core.
 * @param sender Sender.
 * @param message Validated client message.
 * @returns Whether this message belongs to fork controls.
 */
export function handlerCustomControl(core: ServerCore, sender: ConnectionSession, message: ClientMessage): boolean {
  if (message.t === 'compatibility.result')
    core.compatibility.result(sender, message.q, message.allow, message.reason, message.homeUrl);
  else if (message.t === 'custom.lock.acquire' || message.t === 'custom.lock.release')
    handlerCustomLock(core, sender, message);
  else return false;
  return true;
}
