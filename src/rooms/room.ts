/**
 * One collaboration room: owner, members, locks and in-flight streams. Holds no
 * world data.
 */
import type { ConnectionSession } from '../connection/connection_session.ts';
import type { RoomListEntry, RoomMemberEntry, StreamKind } from '../shared/protocol_definitions.ts';
import type { LimiterSharedBudget } from '../network/limiter_shared_budget.ts';
import { RoomLockTable } from './room_lock_table.ts';

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
  passwordHash: string | null;
  internalTest: boolean;
  maxUsers: number;
  owner: ConnectionSession;
  locksPerUser: number;
  locksPerRoom: number;
  locksServerBudget?: LimiterSharedBudget;
}

/** Live room state. */
export class Room {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly passwordHash: string | null;
  readonly internalTest: boolean;
  readonly maxUsers: number;
  readonly owner: ConnectionSession;
  readonly ownerIpKey: string;
  readonly members = new Map<number, ConnectionSession>();
  private readonly colorSlots = new Map<number, number>();
  readonly locks: RoomLockTable;
  readonly streams = new Map<string, RoomStream>();
  /**
   * Latest relayed presence frame per member, handed to members when they
   * finish syncing.
   */
  readonly presenceLatest = new Map<number, Uint8Array>();
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
    this.locks = new RoomLockTable(options.locksPerUser, options.locksPerRoom, options.locksServerBudget);
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
  }

  /**
   * Removes a member and frees its color slot.
   *
   * @param user Member user id.
   */
  memberDelete(user: number): void {
    this.members.delete(user);
    this.colorSlots.delete(user);
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
      color: this.colorOf(member.user),
    }));
  }
}
