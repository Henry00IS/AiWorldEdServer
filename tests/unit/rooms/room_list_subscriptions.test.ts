/**
 * RoomListSubscriptions: coalesced pushes at most once per interval, deltas
 * only, the subscriber limit, low priority behind queued traffic and hidden
 * internal test rooms for proxied subscribers. A manual clock drives the
 * timers, so no test depends on real time.
 */
import { expect, test } from 'bun:test';
import type { ConnectionSession } from '../../../src/connection/connection_session.ts';
import type { Room } from '../../../src/rooms/room.ts';
import {
  RoomListSubscriptions,
  roomListUpdateBuild,
  type RoomListScheduler,
} from '../../../src/rooms/room_list_subscriptions.ts';
import type { RoomListEntry } from '../../../src/shared/protocol_definitions.ts';

/** Manual clock: timers run only when the test advances time. */
class SchedulerManual implements RoomListScheduler {
  time = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;

  /**
   * Reads the manual clock.
   *
   * @returns Current manual time.
   */
  now(): number {
    return this.time;
  }

  /**
   * Registers a timer that runs when the clock passes its due time.
   *
   * @param callback Timer callback.
   * @param delayMs Delay.
   * @returns Handle.
   */
  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.time + delayMs, callback });
    return handle;
  }

  /**
   * Cancels a pending timer.
   *
   * @param handle Timer handle.
   */
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /**
   * Counts the pending timers.
   *
   * @returns Number of pending timers.
   */
  pending(): number {
    return this.timers.size;
  }

  /**
   * Advances time and runs the timers that came due, in order.
   *
   * @param ms Milliseconds to advance.
   */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) break;
      this.timers.delete(first[0]);
      this.time = Math.max(this.time, first[1].at);
      first[1].callback();
    }
    this.time = target;
  }
}

/** Fake subscriber session recording what it received. */
interface SessionRecorded {
  session: ConnectionSession;
  received: any[];
  busy: { value: boolean };
}

/**
 * Builds a fake session whose outbound queue records frames.
 *
 * @param user User id.
 * @param via Connection kind.
 * @returns Fake session with its inbox and busy toggle.
 */
function sessionRecorded(user: number, via: 'direct' | 'proxy' = 'direct'): SessionRecorded {
  const received: any[] = [];
  const busy = { value: false };
  const outbound = {
    pushText: (data: string) => received.push(JSON.parse(data)),
    sendIfIdle: (data: string) => (busy.value ? false : (received.push(JSON.parse(data)), true)),
  };
  const session = {
    user,
    via,
    closed: false,
    outbound,
    protocol: { version: 2, caps: new Set(['select']), client: 'test' },
  } as unknown as ConnectionSession;
  return { session, received, busy };
}

/** Listing fields shared by every fake room. */
const ROOM_FAKE_ENTRY = { private: false, maxUsers: 8, owner: 'Henry', protocol: 2, editor: 'AiWorldEd/test' } as const;

/**
 * Builds a fake room with a mutable description.
 *
 * @param id Room id.
 * @param users Member count.
 * @param internalTest Internal test room flag.
 * @returns Fake room.
 */
function roomFake(id: string, users = 1, internalTest = false): Room & { users: number } {
  const room = {
    id,
    internalTest,
    users,
    /**
     * Describes the fake room.
     *
     * @returns Listing entry.
     */
    describe(): RoomListEntry {
      return { ...ROOM_FAKE_ENTRY, id, name: `room ${id}`, users: room.users };
    },
  };
  return room as unknown as Room & { users: number };
}

/**
 * Builds a subscription table over a mutable room array.
 *
 * @param rooms Live rooms.
 * @param overrides Option overrides.
 * @returns Table and its manual scheduler.
 */
function tableCreate(rooms: Room[], overrides: Record<string, number> = {}) {
  const scheduler = new SchedulerManual();
  const table = new RoomListSubscriptions({
    rooms: () => rooms,
    subscribersMaximum: 4,
    roomListMaximum: 50,
    pushIntervalMs: 500,
    lowPriorityHighWaterBytes: 1024,
    scheduler,
    ...overrides,
  });
  return { table, scheduler };
}

test('subscribe replies with the full list including the owner name', () => {
  const { table } = tableCreate([roomFake('a'), roomFake('b')]);
  const alice = sessionRecorded(1);
  expect(table.subscribe(alice.session, 7)).toBe('ok');
  expect(alice.received[0].t).toBe('room.subscribed');
  expect(alice.received[0].r).toBe(7);
  expect(alice.received[0].rooms.map((room: RoomListEntry) => room.id)).toEqual(['a', 'b']);
  expect(alice.received[0].rooms[0].owner).toBe('Henry');
});

test('many changes within one interval are coalesced into one delta push', () => {
  const rooms: Room[] = [roomFake('a')];
  const { table, scheduler } = tableCreate(rooms);
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  for (let index = 0; index < 20; index++) (rooms.push(roomFake(`n${index}`)), table.changed());
  rooms.shift();
  table.changed();
  scheduler.advance(499);
  expect(alice.received.length).toBe(1);
  scheduler.advance(1);
  expect(alice.received.length).toBe(2);
  const update = alice.received[1];
  expect(update.t).toBe('room.list.update');
  expect(update.rooms.length).toBe(20);
  expect(update.removed).toEqual(['a']);
  expect(table.pushesSent()).toBe(1);
  scheduler.advance(5000);
  expect(alice.received.length).toBe(2);
});

test('only changed entries are pushed; an unchanged list sends nothing', () => {
  const room = roomFake('a');
  const { table, scheduler } = tableCreate([room, roomFake('b')]);
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  table.changed();
  scheduler.advance(500);
  expect(alice.received.length).toBe(1);
  room.users = 3;
  table.changed();
  scheduler.advance(500);
  expect(alice.received[1].rooms).toEqual([{ ...room.describe() }]);
  expect(alice.received[1].removed).toEqual([]);
});

test('pushes are spaced by at least the interval per subscriber', () => {
  const rooms: Room[] = [];
  const { table, scheduler } = tableCreate(rooms);
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  const pushTimes: number[] = [];
  for (let step = 0; step < 40; step++) {
    rooms.push(roomFake(`r${step}`));
    table.changed();
    const before = alice.received.length;
    scheduler.advance(50);
    if (alice.received.length > before) pushTimes.push(scheduler.now());
  }
  expect(pushTimes.length).toBeGreaterThan(1);
  for (let index = 1; index < pushTimes.length; index++)
    expect((pushTimes[index] as number) - (pushTimes[index - 1] as number)).toBeGreaterThanOrEqual(500);
});

test('a busy socket defers the push instead of queueing it behind edits', () => {
  const rooms: Room[] = [];
  const { table, scheduler } = tableCreate(rooms);
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  alice.busy.value = true;
  rooms.push(roomFake('a'));
  table.changed();
  scheduler.advance(2000);
  expect(alice.received.length).toBe(1);
  alice.busy.value = false;
  scheduler.advance(500);
  expect(alice.received.length).toBe(2);
  expect(alice.received[1].rooms[0].id).toBe('a');
});

test('the list is capped at the room list maximum', () => {
  const rooms: Room[] = Array.from({ length: 10 }, (_, index) => roomFake(`r${index}`));
  const { table } = tableCreate(rooms, { roomListMaximum: 3 });
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  expect(alice.received[0].rooms.length).toBe(3);
});

test('the subscriber limit is enforced and resubscribing does not count twice', () => {
  const { table } = tableCreate([], { subscribersMaximum: 2 });
  const first = sessionRecorded(1);
  expect(table.subscribe(first.session, undefined)).toBe('ok');
  expect(table.subscribe(first.session, undefined)).toBe('ok');
  expect(table.subscribe(sessionRecorded(2).session, undefined)).toBe('ok');
  expect(table.subscribe(sessionRecorded(3).session, undefined)).toBe('subscription_limit');
  expect(table.size()).toBe(2);
});

test('unsubscribed sessions get no more pushes and their timer is cleared', () => {
  const rooms: Room[] = [];
  const { table, scheduler } = tableCreate(rooms);
  const alice = sessionRecorded(1);
  table.subscribe(alice.session, undefined);
  rooms.push(roomFake('a'));
  table.changed();
  expect(scheduler.pending()).toBe(1);
  expect(table.unsubscribe(alice.session)).toBe(true);
  expect(scheduler.pending()).toBe(0);
  scheduler.advance(1000);
  expect(alice.received.length).toBe(1);
  expect(table.unsubscribe(alice.session)).toBe(false);
});

test('internal test rooms are never pushed to proxied subscribers', () => {
  const rooms: Room[] = [roomFake('public'), roomFake('internal', 1, true)];
  const { table } = tableCreate(rooms);
  const proxied = sessionRecorded(1, 'proxy');
  const direct = sessionRecorded(2, 'direct');
  table.subscribe(proxied.session, undefined);
  table.subscribe(direct.session, undefined);
  expect(proxied.received[0].rooms.map((room: RoomListEntry) => room.id)).toEqual(['public']);
  expect(direct.received[0].rooms.map((room: RoomListEntry) => room.id)).toEqual(['public', 'internal']);
});

test('roomListUpdateBuild returns null when nothing changed', () => {
  const entries = new Map([['a', '{"id":"a"}']]);
  expect(roomListUpdateBuild(entries, new Map(entries))).toBeNull();
});
