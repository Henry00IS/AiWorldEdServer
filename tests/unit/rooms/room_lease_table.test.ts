/**
 * Unit tests for the per-room lease table: deadlines, the idle and absolute
 * caps, and lease numbers that only grow.
 */
import { expect, test } from 'bun:test';
import { RoomLeaseTable } from '../../../src/rooms/room_lease_table.ts';

/**
 * Creates a lease table on a hand-driven clock.
 *
 * @returns Table and a function advancing the clock.
 */
function tableFake(): { table: RoomLeaseTable; advance: (ms: number) => void } {
  let now = 0;
  const table = new RoomLeaseTable({ leaseMs: 100, idleMaximumMs: 500, totalMaximumMs: 1000 }, () => now);
  return { table, advance: (ms) => (now += ms) };
}

test('a lease runs out without renewal and renewals push the deadline', () => {
  const { table, advance } = tableFake();
  table.begin(1, 3);
  advance(90);
  expect(table.renew(1, 3)).toBe(true);
  advance(90);
  expect(table.expired()).toEqual([]);
  advance(20);
  expect(table.expired()).toEqual([1]);
});

test('renewing another lease number does nothing', () => {
  const { table, advance } = tableFake();
  table.begin(1, 3);
  expect(table.renew(1, 2)).toBe(false);
  expect(table.renew(2, 3)).toBe(false);
  advance(100);
  expect(table.expired()).toEqual([1]);
});

test('renewals alone stop counting after the idle maximum; progress resets it', () => {
  const { table, advance } = tableFake();
  table.begin(1, 1);
  for (let tick = 0; tick < 4; tick++) {
    advance(99);
    table.renew(1, 1);
  }
  table.progress(1);
  for (let tick = 0; tick < 5; tick++) {
    advance(99);
    table.renew(1, 1);
  }
  expect(table.expired()).toEqual([]);
  advance(10);
  expect(table.expired()).toEqual([1]);
});

test('an operation cannot outlive the absolute maximum', () => {
  const { table, advance } = tableFake();
  table.begin(1, 1);
  for (let tick = 0; tick < 10; tick++) {
    advance(99);
    table.progress(1);
  }
  expect(table.expired()).toEqual([]);
  advance(20);
  table.progress(1);
  expect(table.expired()).toEqual([1]);
});

test('lease numbers are remembered after the lease ends until the member leaves', () => {
  const { table } = tableFake();
  table.begin(1, 7);
  table.end(1);
  expect(table.of(1)).toBeUndefined();
  expect(table.lastId(1)).toBe(7);
  table.begin(1, 4);
  expect(table.lastId(1)).toBe(7);
  table.forget(1);
  expect(table.lastId(1)).toBe(0);
  expect(table.count()).toBe(0);
});
