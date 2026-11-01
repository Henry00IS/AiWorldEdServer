/**
 * Configuration for local tests. The forwarded secret here is a dummy value
 * that only exists in tests; the real proxy secret never appears in the repo.
 */
import { configurationDefault, type ServerConfiguration } from '../../src/config/server_configuration.ts';

/** Dummy proxy secret used to simulate requests that came through the proxy. */
export const TEST_DUMMY_FORWARDED_SECRET = 'dummy-test-secret-0000-not-real';
/** Origin sent by the test clients. */
export const TEST_ORIGIN = 'http://localhost:5173';

/**
 * @param overrides Fields to override.
 * @returns Test configuration bound to an ephemeral loopback port.
 */
export function testConfiguration(overrides: Partial<ServerConfiguration> = {}): ServerConfiguration {
  return {
    ...configurationDefault(),
    hostname: '127.0.0.1',
    port: 0,
    forwardedSecret: TEST_DUMMY_FORWARDED_SECRET,
    ...overrides,
  };
}
