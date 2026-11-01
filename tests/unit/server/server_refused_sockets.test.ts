/** The bounded count of refused sockets kept open to deliver a close reason. */
import { expect, test } from 'bun:test';
import { ServerRefusedSockets } from '../../../src/server/server_refused_sockets.ts';

test('refused sockets are bounded and released', () => {
  const refusedSockets = new ServerRefusedSockets(2);
  expect([refusedSockets.tryAcquire(), refusedSockets.tryAcquire(), refusedSockets.tryAcquire()]).toEqual([
    true,
    true,
    false,
  ]);
  refusedSockets.release();
  expect(refusedSockets.open).toBe(1);
  expect(refusedSockets.tryAcquire()).toBe(true);
});

test('releasing more than was acquired never goes below zero', () => {
  const refusedSockets = new ServerRefusedSockets(1);
  refusedSockets.release();
  expect(refusedSockets.open).toBe(0);
});
