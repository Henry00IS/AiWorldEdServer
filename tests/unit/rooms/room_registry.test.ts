import { expect, test } from 'bun:test';
import { RoomRegistry } from '../../../src/rooms/room_registry.ts';

test('registry enforces per-IP and total room limits with reservations', () => {
  const registry = new RoomRegistry(2, 3);
  expect(registry.reserve('ip1')).toBe('ok');
  expect(registry.reserve('ip1')).toBe('ok');
  expect(registry.reserve('ip1')).toBe('room_limit_ip');
  expect(registry.reserve('ip2')).toBe('ok');
  expect(registry.reserve('ip3')).toBe('room_limit_server');
  registry.reservationCancel('ip1');
  expect(registry.reserve('ip1')).toBe('ok');
});
