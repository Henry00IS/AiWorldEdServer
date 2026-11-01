/**
 * Live room list subscriptions. Sessions that opened the room browser get
 * coalesced, low-priority `room.list.update` pushes instead of polling.
 */
import { sessionSend, type ConnectionSession } from '../connection/connection_session.ts';
import type { RoomListEntry, RoomListUpdateMessage } from '../shared/protocol_definitions.ts';
import type { Room } from './room.ts';

/** Clock and timer functions, replaceable in tests. */
export interface RoomListScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Limits and dependencies of the subscription table. */
export interface RoomListSubscriptionsOptions {
  /** Live rooms, in listing order. */
  rooms: () => Iterable<Room>;
  /** Sessions that may be subscribed at the same time. */
  subscribersMaximum: number;
  /** Rooms one list or update covers at most. */
  roomListMaximum: number;
  /** Minimum time between two pushes to one subscriber. */
  pushIntervalMs: number;
  /** Socket buffer level at or above which a push waits for later. */
  lowPriorityHighWaterBytes: number;
  scheduler?: RoomListScheduler;
}

/** State kept per subscribed session. */
interface RoomListSubscriber {
  readonly session: ConnectionSession;
  sentEntries: Map<string, string>;
  timer: unknown;
  lastPushAt: number;
}

/** Default scheduler: the real clock and timers. */
const ROOM_LIST_SCHEDULER_REAL: RoomListScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Returns whether a room may appear in a session's pushed list. Internal test
 * rooms are only pushed to direct (loopback) connections, never to proxied
 * ones.
 *
 * @param room Live room.
 * @param session Subscriber.
 * @returns True when the room is visible to the subscriber.
 */
export function roomListSubscriptionVisible(room: Room, session: ConnectionSession): boolean {
  return !room.internalTest || session.via === 'direct';
}

/** Table of sessions subscribed to the live room list. */
export class RoomListSubscriptions {
  private readonly subscribers = new Map<number, RoomListSubscriber>();
  private readonly scheduler: RoomListScheduler;
  private pushCount = 0;

  /**
   * Creates an empty subscription table.
   *
   * @param options Room source, limits and optional scheduler.
   */
  constructor(private readonly options: RoomListSubscriptionsOptions) {
    this.scheduler = options.scheduler ?? ROOM_LIST_SCHEDULER_REAL;
  }

  /**
   * Subscribes a session (or restarts its subscription) and sends the full list
   * in `room.subscribed`.
   *
   * @param session Subscriber.
   * @param requestId Request id to echo, if any.
   * @returns 'ok', or 'subscription_limit' when the table is full.
   */
  subscribe(session: ConnectionSession, requestId: number | undefined): 'ok' | 'subscription_limit' {
    const known = this.subscribers.has(session.user);
    if (!known && this.subscribers.size >= this.options.subscribersMaximum) return 'subscription_limit';
    this.unsubscribe(session);
    const rooms = this.visibleEntries(session);
    this.subscribers.set(session.user, {
      session,
      sentEntries: roomListEntryMap(rooms),
      timer: null,
      lastPushAt: this.scheduler.now(),
    });
    sessionSend(session, { t: 'room.subscribed', r: requestId, rooms, intervalMs: this.options.pushIntervalMs });
    return 'ok';
  }

  /**
   * Ends a session's subscription, if any.
   *
   * @param session Session to unsubscribe.
   * @returns True when the session was subscribed.
   */
  unsubscribe(session: ConnectionSession): boolean {
    const subscriber = this.subscribers.get(session.user);
    if (!subscriber) return false;
    if (subscriber.timer !== null) this.scheduler.clearTimeout(subscriber.timer);
    this.subscribers.delete(session.user);
    return true;
  }

  /** Notes that the room list changed; every subscriber gets a push soon. */
  changed(): void {
    for (const subscriber of this.subscribers.values()) this.pushSchedule(subscriber);
  }

  /**
   * Counts the subscribed sessions.
   *
   * @returns Number of subscribers.
   */
  size(): number {
    return this.subscribers.size;
  }

  /**
   * Counts the updates sent since the table was created.
   *
   * @returns Number of `room.list.update` frames sent.
   */
  pushesSent(): number {
    return this.pushCount;
  }

  /** Drops every subscription and timer (server shutdown). */
  stop(): void {
    for (const subscriber of [...this.subscribers.values()]) this.unsubscribe(subscriber.session);
  }

  /**
   * Arms the push timer of a subscriber unless one is pending, keeping at least
   * the push interval between two pushes.
   *
   * @param subscriber Subscriber to push to.
   */
  private pushSchedule(subscriber: RoomListSubscriber): void {
    if (subscriber.timer !== null) return;
    const delayMs = Math.max(0, subscriber.lastPushAt + this.options.pushIntervalMs - this.scheduler.now());
    subscriber.timer = this.scheduler.setTimeout(() => this.pushRun(subscriber), delayMs);
  }

  /**
   * Sends the changes since the last push. Waits for another interval while the
   * subscriber's socket is busy with edits or streams.
   *
   * @param subscriber Subscriber to push to.
   */
  private pushRun(subscriber: RoomListSubscriber): void {
    subscriber.timer = null;
    if (this.subscribers.get(subscriber.session.user) !== subscriber || subscriber.session.closed) return;
    const current = roomListEntryMap(this.visibleEntries(subscriber.session));
    const update = roomListUpdateBuild(subscriber.sentEntries, current);
    if (!update) return;
    const sent = subscriber.session.outbound.sendIfIdle(JSON.stringify(update), this.options.lowPriorityHighWaterBytes);
    subscriber.lastPushAt = this.scheduler.now();
    if (!sent) return this.pushSchedule(subscriber);
    subscriber.sentEntries = current;
    this.pushCount++;
  }

  /**
   * Lists the rooms a subscriber may see, capped at the list maximum.
   *
   * @param session Subscriber.
   * @returns Room entries in listing order.
   */
  private visibleEntries(session: ConnectionSession): RoomListEntry[] {
    const entries: RoomListEntry[] = [];
    for (const room of this.options.rooms()) {
      if (entries.length >= this.options.roomListMaximum) break;
      if (roomListSubscriptionVisible(room, session)) entries.push(room.describe());
    }
    return entries;
  }
}

/**
 * Indexes room entries by id with their serialized form, for change detection.
 *
 * @param entries Room entries.
 * @returns Map of room id to serialized entry.
 */
function roomListEntryMap(entries: readonly RoomListEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]));
}

/**
 * Builds the update between what a subscriber saw and the current list.
 *
 * @param sentEntries Entries the subscriber has.
 * @param currentEntries Entries it should have.
 * @returns Update message, or null when nothing changed.
 */
export function roomListUpdateBuild(
  sentEntries: ReadonlyMap<string, string>,
  currentEntries: ReadonlyMap<string, string>,
): RoomListUpdateMessage | null {
  const rooms: RoomListEntry[] = [];
  for (const [id, serialized] of currentEntries)
    if (sentEntries.get(id) !== serialized) rooms.push(JSON.parse(serialized) as RoomListEntry);
  const removed = [...sentEntries.keys()].filter((id) => !currentEntries.has(id));
  if (rooms.length === 0 && removed.length === 0) return null;
  return { t: 'room.list.update', rooms, removed };
}
