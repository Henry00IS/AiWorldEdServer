import { describe, expect, test } from 'bun:test';
import { configurationFromEnvironment } from '../../../src/config/configuration_load.ts';
import { configurationDefault } from '../../../src/config/server_configuration.ts';
import { CHAT_TEXT_WIRE_MAXIMUM } from '../../../src/shared/chat_text_policy.ts';

describe('server configuration', () => {
  test('chat allows one 2000 code point, 20 line message per 5 s and 64 waiting per recipient', () => {
    const defaults = configurationDefault();
    expect(defaults.chatIntervalMs).toBe(5000);
    expect(defaults.chatTextLengthMaximum).toBe(2000);
    expect(defaults.chatTextLinesMaximum).toBe(20);
    expect(defaults.chatPendingPerRecipient).toBe(64);
    expect(defaults.chatTextLengthMaximum * 2).toBeLessThanOrEqual(CHAT_TEXT_WIRE_MAXIMUM);
  });

  test('owner verification waits 5 s, allows 10/s (burst 20) per member and 50/s (burst 100) per room', () => {
    const defaults = configurationDefault();
    expect(defaults.verifyTimeoutMs).toBe(5000);
    expect([defaults.verifyPerMemberPerSecond, defaults.verifyPerMemberBurst]).toEqual([10, 20]);
    expect([defaults.verifyPerRoomPerSecond, defaults.verifyPerRoomBurst]).toEqual([50, 100]);
    expect([defaults.verifyQueueMessagesMaximum, defaults.verifyQueueBytesMaximum]).toEqual([64, 4 * 1024 * 1024]);
  });

  test('internal test rooms through the proxy are off by default', () => {
    expect(configurationDefault().internalTestRoomsViaProxy).toBe(false);
    expect(configurationFromEnvironment({}).internalTestRoomsViaProxy).toBe(false);
    expect(() => configurationFromEnvironment({ INTERNAL_TEST_ROOMS_VIA_PROXY: 'maybe' })).toThrow(
      'INTERNAL_TEST_ROOMS_VIA_PROXY must be true or false',
    );
  });

  test('INTERNAL_TEST_ROOMS_VIA_PROXY=true enables internal test rooms through the proxy', () => {
    const environment = { INTERNAL_TEST_ROOMS: 'true', INTERNAL_TEST_ROOMS_VIA_PROXY: 'true' };
    expect(configurationFromEnvironment(environment).internalTestRoomsViaProxy).toBe(true);
    expect(() => configurationFromEnvironment({ INTERNAL_TEST_ROOMS_VIA_PROXY: 'true' })).toThrow(
      'INTERNAL_TEST_ROOMS_VIA_PROXY=true needs INTERNAL_TEST_ROOMS=true',
    );
  });

  test('per-IP limits keep the production defaults unless overridden', () => {
    const defaults = configurationFromEnvironment({});
    expect(defaults.connectionsPerIp).toBe(24);
    expect(defaults.roomsPerIp).toBe(8);
    const raised = configurationFromEnvironment({ CONNECTIONS_PER_IP: '96', ROOMS_PER_IP: '48' });
    expect(raised.connectionsPerIp).toBe(96);
    expect(raised.roomsPerIp).toBe(48);
  });

  test('the room entry rate per IP defaults to 30/min (burst 10) and can be raised for the dev relay', () => {
    const defaults = configurationFromEnvironment({});
    expect([defaults.roomEntriesPerIpPerMinute, defaults.roomEntryBurstPerIp]).toEqual([30, 10]);
    const raised = configurationFromEnvironment({
      ROOM_ENTRIES_PER_IP_PER_MINUTE: '6000',
      ROOM_ENTRY_BURST_PER_IP: '1000',
    });
    expect([raised.roomEntriesPerIpPerMinute, raised.roomEntryBurstPerIp]).toEqual([6000, 1000]);
    expect(() => configurationFromEnvironment({ ROOM_ENTRY_BURST_PER_IP: '0' })).toThrow('ROOM_ENTRY_BURST_PER_IP');
  });

  test('invalid per-IP limits are rejected', () => {
    expect(() => configurationFromEnvironment({ CONNECTIONS_PER_IP: '0' })).toThrow('CONNECTIONS_PER_IP');
    expect(() => configurationFromEnvironment({ ROOMS_PER_IP: 'many' })).toThrow('ROOMS_PER_IP');
  });

  test('PORT is read from the environment', () => {
    expect(configurationFromEnvironment({ PORT: '8091' }).port).toBe(8091);
    expect(configurationFromEnvironment({}).port).toBe(8081);
  });

  test('WEBSOCKET_PATH defaults to /ws and accepts /wstest', () => {
    expect(configurationFromEnvironment({}).websocketPath).toBe('/ws');
    expect(configurationFromEnvironment({ WEBSOCKET_PATH: '/wstest' }).websocketPath).toBe('/wstest');
    expect(() => configurationFromEnvironment({ WEBSOCKET_PATH: 'wstest' })).toThrow('WEBSOCKET_PATH');
  });
});
