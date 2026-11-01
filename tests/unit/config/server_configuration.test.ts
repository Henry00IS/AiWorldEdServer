import { describe, expect, test } from 'bun:test';
import { configurationDefault, configurationFromEnvironment } from '../../../src/config/server_configuration.ts';

describe('server configuration', () => {
  test('internal test rooms through the proxy are off by default', () => {
    expect(configurationDefault().internalTestRoomsViaProxy).toBe(false);
    expect(configurationFromEnvironment({}).internalTestRoomsViaProxy).toBe(false);
    expect(configurationFromEnvironment({ INTERNAL_TEST_ROOMS_VIA_PROXY: '1' }).internalTestRoomsViaProxy).toBe(false);
  });

  test('INTERNAL_TEST_ROOMS_VIA_PROXY=true enables internal test rooms through the proxy', () => {
    expect(configurationFromEnvironment({ INTERNAL_TEST_ROOMS_VIA_PROXY: 'true' }).internalTestRoomsViaProxy).toBe(
      true,
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

  test('invalid per-IP limits are rejected', () => {
    expect(() => configurationFromEnvironment({ CONNECTIONS_PER_IP: '0' })).toThrow('CONNECTIONS_PER_IP');
    expect(() => configurationFromEnvironment({ ROOMS_PER_IP: 'many' })).toThrow('ROOMS_PER_IP');
  });

  test('PORT is read from the environment', () => {
    expect(configurationFromEnvironment({ PORT: '8091' }).port).toBe(8091);
    expect(configurationFromEnvironment({}).port).toBe(8081);
  });
});
