/**
 * One collaboration room: owner, members, locks and in-flight streams. Holds no
 * world data.
 */
import type { ConnectionProtocol, ConnectionSession } from '../connection/connection_session.ts';
import type { RoomListEntry, RoomMemberEntry, StreamKind } from '../shared/protocol_definitions.ts';
import { LimiterSharedBudget } from '../network/limiter_shared_budget.ts';
import { LimiterTokenBucket } from '../network/limiter_token_bucket.ts';
import { displayNameKey } from '../shared/room_name_policy.ts';
import { RoomLeaseTable, ROOM_LEASE_TIMINGS_DEFAULT, type RoomLeaseTimings } from './room_lease_table.ts';
import { RoomLockTable } from './room_lock_table.ts';

/** Most abuse flags a room keeps for the owner's kick decisions. */
export const ROOM_ABUSE_FLAGS_MAXIMUM = 64;
/** Most addresses a room keeps on its rejoin cooldown list. */
export const ROOM_JOIN_COOLDOWNS_MAXIMUM = 256;

/** A member the relay throttled or closed for abuse, kept for the owner. */
export interface RoomAbuseFlag {
  readonly user: number;
  readonly name: string;
  readonly reason: string;
  readonly closed: boolean;
}

/** One owner-to-member stream that is currently in flight. */
export interface RoomStream {
  readonly to: number;
  readonly id: number;
  readonly kind: StreamKind;
  readonly size: number;
  received: number;
  delivered: number;
  creditedAt: number;
  ended: boolean;
}

/** Room construction parameters. */
export interface RoomOptions {
  id: string;
  name: string;
  isPrivate: boolean;
  editMode?: 'viewers' | 'anyone';
  passwordHash: string | null;
  internalTest: boolean;
  maxUsers: number;
  owner: ConnectionSession;
  locksPerUser: number;
  locksPerRoom: number;
  /** Owner queries per second for the whole room (default 50). */
  verifyPerSecond?: number;
  /** Burst of owner queries for the whole room (default 100). */
  verifyBurst?: number;
  /** Edit lease timings. */
  leaseTimings?: RoomLeaseTimings;
  /** One-shot edit messages per second for the whole room (default 200). */
  oneShotPerSecond?: number;
  /** Burst of one-shot edit messages for the whole room (default 400). */
  oneShotBurst?: number;
}

/** Reactions of a recent chat message; its text is not kept. */
export interface RoomChatReactable {
  /** Relay time the message was sent (epoch ms). */
  at: number;
  /** Members who reacted, by emoji. */
  readonly reactions: Map<string, Set<number>>;
  /** Reactions of all members together. */
  total: number;
}

/** Live room state. */
export class Room {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly editMode: 'viewers' | 'anyone';
  private readonly editors = new Set<number>();
  readonly passwordHash: string | null;
  readonly internalTest: boolean;
  readonly maxUsers: number;
  readonly owner: ConnectionSession;
  readonly ownerIpKey: string;
  /**
   * Protocol the room was created with (the owner's negotiated version,
   * capabilities and editor build). Joiners must speak the same version.
   */
  readonly protocol: ConnectionProtocol;
  readonly members = new Map<number, ConnectionSession>();
  private readonly colorSlots = new Map<number, number>();
  readonly locks: RoomLockTable;
  readonly customLocks: RoomLockTable;
  readonly streams = new Map<string, RoomStream>();
  /**
   * Latest relayed presence frame per member, handed to members when they
   * finish syncing.
   */
  readonly presenceLatest = new Map<number, Uint8Array>();
  /** Id of the last chat message sent in the room (chat itself is not kept). */
  chatSequence = 0;
  /** Reactions of the recent chat messages by id, oldest first. */
  readonly chatReactable = new Map<number, RoomChatReactable>();
  /**
   * Countdown handles for members flagged as typing. Cleared on leave and when
   * the countdown expires.
   */
  readonly typingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Members waiting for the owner to answer a verify query, by query id; at
   * most one per member.
   */
  readonly verifyWaiting = new Map<number, ConnectionSession>();
  /** Limits the owner queries of the whole room. */
  readonly verifyBucket: LimiterTokenBucket;
  /** Limits the one-shot edit messages of the whole room. */
  readonly oneShotBucket: LimiterTokenBucket;
  /** Members flagged for abuse (oldest dropped first), for a later kick feature. */
  readonly abuseFlags: RoomAbuseFlag[] = [];
  /**
   * Address keys closed for abuse here, with the monotonic time they may
   * rejoin.
   */
  readonly joinCooldowns = new Map<string, number>();
  private verifySequence = 0;
  closed = false;

  /**
   * Creates a room with its owner as the first member.
   *
   * @param options Room parameters; the owner becomes the first member.
   */
  constructor(options: RoomOptions) {
    this.id = options.id;
    this.name = options.name;
    this.isPrivate = options.isPrivate;
    this.passwordHash = options.passwordHash;
    this.internalTest = options.internalTest;
    this.maxUsers = options.maxUsers;
    this.owner = options.owner;
    this.ownerIpKey = options.owner.ipKey;
    this.protocol = options.owner.protocol;
    const tables = roomLockTables(options);
    this.locks = tables.locks;
    this.customLocks = tables.customLocks;
    this.verifyBucket = new LimiterTokenBucket(options.verifyPerSecond ?? 50, options.verifyBurst ?? 100);
    this.oneShotBucket = new LimiterTokenBucket(options.oneShotPerSecond ?? 200, options.oneShotBurst ?? 400);
    this.editMode = options.isPrivate ? 'anyone' : (options.editMode ?? 'viewers');
    this.memberAdd(options.owner);
  }

  /**
   * Adds a member and gives it the lowest color slot no current member holds.
   *
   * @param session New member.
   */
  memberAdd(session: ConnectionSession): void {
    const used = new Set(this.colorSlots.values());
    let slot = 0;
    while (used.has(slot)) slot++;
    this.colorSlots.set(session.user, slot);
    this.members.set(session.user, session);
    if (session === this.owner || this.editMode === 'anyone') this.editors.add(session.user);
  }

  /**
   * Removes a member and frees its color slot.
   *
   * @param user Member user id.
   */
  memberDelete(user: number): void {
    this.members.delete(user);
    this.editors.delete(user);
    this.colorSlots.delete(user);
    this.locks.leases.forget(user);
  }

  /**
   * Reports the current connection's edit permission.
   *
   * @param session Current member connection.
   * @returns Whether the member may write.
   */
  canEdit(session: ConnectionSession): boolean {
    return !this.closed && this.members.get(session.user) === session && this.editors.has(session.user);
  }

  /**
   * Sets a current non-owner member's permission.
   *
   * @param user Current member id.
   * @param allowed Whether editing is allowed.
   */
  permissionSet(user: number, allowed: boolean): void {
    if (!this.members.has(user) || user === this.owner.user) return;
    if (allowed) this.editors.add(user);
    else this.editors.delete(user);
  }

  /**
   * Records an abuse flag, dropping the oldest beyond the cap.
   *
   * @param flag Flag to keep.
   */
  abuseFlag(flag: RoomAbuseFlag): void {
    this.abuseFlags.push(flag);
    if (this.abuseFlags.length > ROOM_ABUSE_FLAGS_MAXIMUM) this.abuseFlags.shift();
  }

  /**
   * Keeps an address out of the room until a monotonic time.
   *
   * @param ipKey Address key.
   * @param untilMs Monotonic time it may rejoin.
   */
  joinCooldownSet(ipKey: string, untilMs: number): void {
    this.joinCooldowns.delete(ipKey);
    if (this.joinCooldowns.size >= ROOM_JOIN_COOLDOWNS_MAXIMUM)
      this.joinCooldowns.delete(this.joinCooldowns.keys().next().value as string);
    this.joinCooldowns.set(ipKey, untilMs);
  }

  /**
   * Reports whether an address is still cooling down after an abuse close.
   *
   * @param ipKey Address key.
   * @param nowMs Monotonic time.
   * @returns True while the address may not rejoin.
   */
  joinCoolingDown(ipKey: string, nowMs: number): boolean {
    const until = this.joinCooldowns.get(ipKey);
    if (until === undefined) return false;
    if (nowMs < until) return true;
    this.joinCooldowns.delete(ipKey);
    return false;
  }

  /**
   * Lists the comparison keys of the members' display names.
   *
   * @returns Keys from {@link displayNameKey}.
   */
  memberNameKeys(): Set<string> {
    const keys = new Set<string>();
    for (const member of this.members.values()) keys.add(displayNameKey(member.name));
    return keys;
  }

  /**
   * Allocates the id of the next verify query.
   *
   * @returns Query id between 1 and 0xffffffff, not used by an open query.
   */
  verifyQueryNext(): number {
    do {
      this.verifySequence = this.verifySequence >= 0xffffffff ? 1 : this.verifySequence + 1;
    } while (this.verifyWaiting.has(this.verifySequence));
    return this.verifySequence;
  }

  /**
   * Looks up the color slot of a member.
   *
   * @param user Member user id.
   * @returns The member's color slot (0 for unknown users).
   */
  colorOf(user: number): number {
    return this.colorSlots.get(user) ?? 0;
  }

  /**
   * Builds the map key of a stream from its recipient and id.
   *
   * @param to Recipient user id.
   * @param id Stream id.
   * @returns Map key of the stream.
   */
  static streamKey(to: number, id: number): string {
    return `${to}:${id}`;
  }

  /**
   * Counts the streams in flight to one member.
   *
   * @param to Recipient user id.
   * @returns Number of active streams to that member.
   */
  streamCountFor(to: number): number {
    let count = 0;
    for (const stream of this.streams.values()) if (stream.to === to) count++;
    return count;
  }

  /**
   * Removes and returns every stream addressed to a member.
   *
   * @param to Recipient user id.
   * @returns Removed streams.
   */
  streamsRemoveFor(to: number): RoomStream[] {
    const removed = [...this.streams.values()].filter((stream) => stream.to === to);
    for (const stream of removed) this.streams.delete(Room.streamKey(stream.to, stream.id));
    return removed;
  }

  /**
   * Describes the room for list and join replies.
   *
   * @returns Public description used in list and join replies.
   */
  describe(): RoomListEntry {
    return {
      id: this.id,
      name: this.name,
      private: this.isPrivate,
      users: this.members.size,
      maxUsers: this.maxUsers,
      owner: this.owner.name,
      protocol: this.protocol.version,
      editor: this.protocol.client,
    };
  }

  /**
   * Lists the members for join replies.
   *
   * @returns Member listing for join replies.
   */
  memberList(): RoomMemberEntry[] {
    return [...this.members.values()].map((member) => ({
      user: member.user,
      name: member.name,
      owner: member === this.owner,
      canEdit: this.canEdit(member),
      color: this.colorOf(member.user),
    }));
  }
}

/**
 * Creates both lock tables sharing one room budget.
 *
 * @param options Room construction limits.
 * @returns Scene and custom lock tables.
 */
function roomLockTables(options: RoomOptions): { locks: RoomLockTable; customLocks: RoomLockTable } {
  const budget = new LimiterSharedBudget(options.locksPerRoom);
  return {
    locks: new RoomLockTable(
      options.locksPerUser,
      options.locksPerRoom,
      budget,
      new RoomLeaseTable(options.leaseTimings ?? ROOM_LEASE_TIMINGS_DEFAULT),
    ),
    customLocks: new RoomLockTable(options.locksPerUser, options.locksPerRoom, budget),
  };
}
