/** All live rooms plus the per-address and global room limits. */
import { LimiterKeyCounter } from '../network/limiter_key_counter.ts';
import type { Room } from './room.ts';

/** Registry of live rooms. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly roomsPerIpKey: LimiterKeyCounter;

  /**
   * @param roomsPerIpMaximum Rooms one address (or IPv6 /64) may own.
   * @param roomsTotalMaximum Rooms the server hosts at most.
   */
  constructor(
    roomsPerIpMaximum: number,
    private readonly roomsTotalMaximum: number,
  ) {
    this.roomsPerIpKey = new LimiterKeyCounter(roomsPerIpMaximum);
  }

  /**
   * Reserves a room slot for an address before the (async) creation completes.
   *
   * @param ipKey Owner limit key.
   * @returns 'ok', or which limit blocked the reservation.
   */
  reserve(ipKey: string): 'ok' | 'room_limit_ip' | 'room_limit_server' {
    if (this.rooms.size + this.reservedCount >= this.roomsTotalMaximum) return 'room_limit_server';
    if (!this.roomsPerIpKey.tryAcquire(ipKey)) return 'room_limit_ip';
    this.reservedCount++;
    return 'ok';
  }

  /**
   * Cancels a reservation that did not turn into a room.
   *
   * @param ipKey Owner limit key.
   */
  reservationCancel(ipKey: string): void {
    this.reservedCount--;
    this.roomsPerIpKey.release(ipKey);
  }

  /**
   * Turns a reservation into a registered room.
   *
   * @param room Newly created room.
   */
  reservationCommit(room: Room): void {
    this.reservedCount--;
    this.rooms.set(room.id, room);
  }

  /**
   * Removes a room and frees its owner's slot.
   *
   * @param room Room to remove.
   */
  remove(room: Room): void {
    if (this.rooms.get(room.id) !== room) return;
    this.rooms.delete(room.id);
    this.roomsPerIpKey.release(room.ownerIpKey);
  }

  /**
   * @param id Room id.
   * @returns The room or undefined.
   */
  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /** @returns Every live room. */
  all(): IterableIterator<Room> {
    return this.rooms.values();
  }

  /** @returns Number of live rooms. */
  size(): number {
    return this.rooms.size;
  }

  private reservedCount = 0;
}
