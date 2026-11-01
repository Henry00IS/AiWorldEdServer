/** Loading the configuration from the environment and the optional config file. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationFromEnvironment, configurationLoad } from '../../../src/config/configuration_load.ts';
import { TEST_DUMMY_FORWARDED_SECRET } from '../../support/test_configuration.ts';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aiworlded-relay-config-'));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('configuration from the environment', () => {
  test('self-host defaults: direct client addresses, no TLS, no internal test rooms', () => {
    const configuration = configurationFromEnvironment({});
    expect(configuration.trustProxy).toBe(false);
    expect(configuration.forwardedSecret).toBeNull();
    expect([configuration.tlsCertificateFile, configuration.tlsKeyFile]).toEqual([null, null]);
    expect(configuration.internalTestRoomsEnabled).toBe(false);
  });

  test('TRUST_PROXY accepts true/false spellings and rejects anything else', () => {
    expect(configurationFromEnvironment({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(configurationFromEnvironment({ TRUST_PROXY: 'ON' }).trustProxy).toBe(true);
    expect(configurationFromEnvironment({ TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(() => configurationFromEnvironment({ TRUST_PROXY: 'ture' })).toThrow('TRUST_PROXY must be true or false');
  });

  test('FORWARDED_SECRET needs TRUST_PROXY and at least 16 characters', () => {
    expect(() => configurationFromEnvironment({ FORWARDED_SECRET: TEST_DUMMY_FORWARDED_SECRET })).toThrow(
      'FORWARDED_SECRET only works with TRUST_PROXY=true',
    );
    const environment = { TRUST_PROXY: 'true', FORWARDED_SECRET: TEST_DUMMY_FORWARDED_SECRET };
    expect(configurationFromEnvironment(environment).forwardedSecret).toBe(TEST_DUMMY_FORWARDED_SECRET);
    expect(() => configurationFromEnvironment({ TRUST_PROXY: 'true', FORWARDED_SECRET: 'short' })).toThrow(
      'FORWARDED_SECRET must be at least 16 characters',
    );
  });

  test('TLS_CERT and TLS_KEY must be set together', () => {
    expect(() => configurationFromEnvironment({ TLS_CERT: '/certs/cert.pem' })).toThrow('TLS_CERT and TLS_KEY');
    expect(() => configurationFromEnvironment({ TLS_KEY: '/certs/key.pem' })).toThrow('TLS_CERT and TLS_KEY');
    const configuration = configurationFromEnvironment({ TLS_CERT: '/certs/cert.pem', TLS_KEY: '/certs/key.pem' });
    expect([configuration.tlsCertificateFile, configuration.tlsKeyFile]).toEqual(['/certs/cert.pem', '/certs/key.pem']);
  });

  test('ALLOWED_ORIGINS replaces the default list, accepts `*` and rejects malformed entries', () => {
    expect(configurationFromEnvironment({ ALLOWED_ORIGINS: '*' }).allowedOrigins).toEqual(['*']);
    const list = configurationFromEnvironment({ ALLOWED_ORIGINS: 'https://studio.example, http://10.1.2.3:*' });
    expect(list.allowedOrigins).toEqual(['https://studio.example', 'http://10.1.2.3:*']);
    expect(() => configurationFromEnvironment({ ALLOWED_ORIGINS: 'studio.example' })).toThrow('ALLOWED_ORIGINS');
    expect(() => configurationFromEnvironment({ ALLOWED_ORIGINS: ' , ' })).toThrow('ALLOWED_ORIGINS');
  });

  test('room size is configurable and the default may not exceed the maximum', () => {
    const configuration = configurationFromEnvironment({ USERS_PER_ROOM_DEFAULT: '48', USERS_PER_ROOM_MAX: '64' });
    expect([configuration.usersPerRoomDefault, configuration.usersPerRoomMaximum]).toEqual([48, 64]);
    expect(() => configurationFromEnvironment({ USERS_PER_ROOM_DEFAULT: '40' })).toThrow(
      'USERS_PER_ROOM_DEFAULT must not exceed USERS_PER_ROOM_MAX',
    );
  });

  test('limits that depend on each other are checked together', () => {
    expect(() => configurationFromEnvironment({ CONNECTIONS_TOTAL: '10' })).toThrow('CONNECTIONS_PER_IP');
    expect(() => configurationFromEnvironment({ ROOMS_TOTAL: '4' })).toThrow('ROOMS_PER_IP');
    expect(() => configurationFromEnvironment({ LOCKS_TOTAL: '10' })).toThrow('LOCKS_PER_ROOM');
  });

  test('empty values count as unset', () => {
    expect(configurationFromEnvironment({ PORT: '', TRUST_PROXY: '' }).port).toBe(8081);
  });
});

describe('configuration file', () => {
  test('the config file sets values and the environment overrides them', async () => {
    const file = join(temporaryDirectory, 'relay.json');
    await Bun.write(
      file,
      JSON.stringify({ PORT: 9000, USERS_PER_ROOM_MAX: 64, TRUST_PROXY: true, ALLOWED_ORIGINS: ['*'] }),
    );
    const loaded = await configurationLoad(['--config', file], { PORT: '9100' });
    expect(loaded.configFile).toBe(file);
    expect(loaded.configuration.port).toBe(9100);
    expect(loaded.configuration.usersPerRoomMaximum).toBe(64);
    expect(loaded.configuration.trustProxy).toBe(true);
    expect(loaded.configuration.allowedOrigins).toEqual(['*']);
  });

  test('CONFIG_FILE names the config file and values in it are validated', async () => {
    const file = join(temporaryDirectory, 'invalid.json');
    await Bun.write(file, JSON.stringify({ USERS_PER_ROOM_MAX: 1 }));
    await expect(configurationLoad([], { CONFIG_FILE: file })).rejects.toThrow('USERS_PER_ROOM_MAX must be an integer');
  });

  test('without a config file only the environment is used', async () => {
    const loaded = await configurationLoad([], { PORT: '9200' });
    expect([loaded.configFile, loaded.configuration.port]).toEqual([null, 9200]);
  });
});
