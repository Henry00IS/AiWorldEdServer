/** Startup summary and warnings. */
import { describe, expect, test } from 'bun:test';
import { configurationFromEnvironment } from '../../../src/config/configuration_load.ts';
import { configurationSummary, configurationWarnings } from '../../../src/config/configuration_summary.ts';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol_definitions.ts';
import { TEST_DUMMY_FORWARDED_SECRET } from '../../support/test_configuration.ts';

describe('startup summary', () => {
  test('describes a default self-hosted relay', () => {
    const summary = configurationSummary(configurationFromEnvironment({}), 8081, null);
    expect(summary).toMatchObject({
      event: 'relay.started',
      protocol: PROTOCOL_VERSION,
      url: 'ws://0.0.0.0:8081/ws',
      tls: false,
      clientAddress: 'socket',
      forwardedSecret: 'unused',
      internalTestRooms: 'off',
      configFile: null,
    });
    expect(summary.limits['usersPerRoomMaximum']).toBe(32);
  });

  test('shows wss, the bound port, bracketed IPv6 and the proxy mode but never the secret', () => {
    const configuration = configurationFromEnvironment({
      HOST: '::',
      TLS_CERT: '/certs/cert.pem',
      TLS_KEY: '/certs/key.pem',
      TRUST_PROXY: 'true',
      FORWARDED_SECRET: TEST_DUMMY_FORWARDED_SECRET,
    });
    const summary = configurationSummary(configuration, 9443, '/etc/relay.json');
    expect(summary).toMatchObject({ url: 'wss://[::]:9443/ws', tls: true, clientAddress: 'forwarded headers' });
    expect(summary.forwardedSecret).toBe('required');
    expect(JSON.stringify(summary)).not.toContain(TEST_DUMMY_FORWARDED_SECRET);
  });
});

describe('startup warnings', () => {
  test('a default relay has no warnings', () => {
    expect(configurationWarnings(configurationFromEnvironment({}))).toEqual([]);
  });

  test('warns about a spoofable proxy setup, any-origin access and test rooms', () => {
    const warnings = configurationWarnings(
      configurationFromEnvironment({ TRUST_PROXY: 'true', ALLOWED_ORIGINS: '*', INTERNAL_TEST_ROOMS: 'true' }),
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('FORWARDED_SECRET');
  });

  test('a proxy-trusting relay bound to a private address is not warned about', () => {
    expect(configurationWarnings(configurationFromEnvironment({ TRUST_PROXY: 'true', HOST: '127.0.0.1' }))).toEqual([]);
  });
});
