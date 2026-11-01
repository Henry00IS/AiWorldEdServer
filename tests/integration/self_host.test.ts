/**
 * Self-hosting options against a real relay: client address accounting with and
 * without TRUST_PROXY, refusals that reach the client as close codes, and
 * built-in TLS.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ServerConfiguration } from '../../src/config/server_configuration.ts';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { testCertificateCreate } from '../support/test_certificate.ts';
import { TestClient } from '../support/test_client.ts';
import { TEST_DUMMY_FORWARDED_SECRET, TEST_ORIGIN, testConfiguration } from '../support/test_configuration.ts';
import { testSocketOutcome } from '../support/test_socket_outcome.ts';

const runningServers: CollabServer[] = [];
afterAll(async () => {
  await Promise.all(runningServers.map((server) => server.stop()));
});

/**
 * Starts a relay that is stopped after the tests.
 *
 * @param overrides Configuration overrides on top of the test configuration.
 * @returns Running relay.
 */
function relayStart(overrides: Partial<ServerConfiguration>): CollabServer {
  const server = collabServerStart(testConfiguration(overrides));
  runningServers.push(server);
  return server;
}

/**
 * Headers of a request that claims to come from the given client address.
 *
 * @param clientIp Claimed client address.
 * @param extra Extra headers.
 * @returns Request headers.
 */
function claimedAddressHeaders(clientIp: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: TEST_ORIGIN, 'X-Real-IP': clientIp, 'X-Forwarded-For': clientIp, ...extra };
}

describe('client address accounting', () => {
  test('direct mode (default) counts the socket address and ignores forged forwarded headers', async () => {
    const server = relayStart({ trustProxy: false, forwardedSecret: null, connectionsPerIp: 2 });
    const first = await TestClient.connect(server.port, { headers: claimedAddressHeaders('198.51.100.1') });
    const second = await TestClient.connect(server.port, { headers: claimedAddressHeaders('198.51.100.2') });
    expect(first.welcome.via).toBe('direct');
    const third = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, {
      headers: claimedAddressHeaders('198.51.100.3'),
    });
    expect([third.code, third.reason]).toEqual([
      CLOSE_CODES.tooManyConnections,
      'too many connections from your address',
    ]);
    first.close();
    second.close();
  });

  test('TRUST_PROXY without a secret counts each forwarded client address separately', async () => {
    const server = relayStart({ trustProxy: true, forwardedSecret: null, connectionsPerIp: 1 });
    const first = await TestClient.connect(server.port, { headers: claimedAddressHeaders('198.51.100.1') });
    const second = await TestClient.connect(server.port, { headers: claimedAddressHeaders('198.51.100.2') });
    expect([first.welcome.via, second.welcome.via]).toEqual(['proxy', 'proxy']);
    const repeated = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, {
      headers: claimedAddressHeaders('198.51.100.1'),
    });
    expect(repeated.code).toBe(CLOSE_CODES.tooManyConnections);
    first.close();
    second.close();
  });

  test('TRUST_PROXY with a secret refuses a wrong secret with a readable close code', async () => {
    const server = relayStart({ trustProxy: true, forwardedSecret: TEST_DUMMY_FORWARDED_SECRET });
    const headers = claimedAddressHeaders('198.51.100.1', { 'X-Forwarded-Secret': 'wrong-secret-value-0000' });
    const outcome = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, { headers });
    expect(outcome.code).toBe(CLOSE_CODES.proxyRefused);
    expect(outcome.reason).toContain('X-Forwarded-Secret');
    expect(outcome.reason).not.toContain(TEST_DUMMY_FORWARDED_SECRET);
  });
});

describe('origin refusals', () => {
  test('a foreign origin gets close code originRefused with the origin in the reason', async () => {
    const server = relayStart({ allowedOrigins: ['https://studio.example'] });
    const outcome = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect([outcome.opened, outcome.code, outcome.reason]).toEqual([
      true,
      CLOSE_CODES.originRefused,
      'origin not allowed: https://evil.example',
    ]);
  });

  test('a refused socket gets no session and frees its slot for later connections', async () => {
    const server = relayStart({ allowedOrigins: ['https://studio.example'], connectionsTotal: 1, connectionsPerIp: 1 });
    await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: 'https://evil.example' } });
    expect(server.core.sessions.size).toBe(0);
    const admitted = await TestClient.connect(server.port, { headers: { Origin: 'https://studio.example' } });
    expect(admitted.welcome.t).toBe('welcome');
    admitted.close();
  });

  test('ALLOWED_ORIGINS=* admits any origin and requests without one', async () => {
    const server = relayStart({ allowedOrigins: ['*'] });
    const foreign = await TestClient.connect(server.port, { headers: { Origin: 'https://anything.example' } });
    expect(foreign.welcome.t).toBe('welcome');
    foreign.close();
    const withoutOrigin = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, { closeWhenOpen: true });
    expect([withoutOrigin.opened, withoutOrigin.code]).toEqual([true, 1000]);
  });

  test('a full relay refuses with serverFull', async () => {
    const server = relayStart({ connectionsTotal: 1, connectionsPerIp: 1 });
    const occupant = await TestClient.connect(server.port);
    const outcome = await testSocketOutcome(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: TEST_ORIGIN } });
    expect([outcome.code, outcome.reason]).toEqual([CLOSE_CODES.serverFull, 'server full']);
    occupant.close();
  });

  test('beyond refusedSocketsMaximum refusals fall back to a plain HTTP status', async () => {
    const server = relayStart({ allowedOrigins: ['https://studio.example'], refusedSocketsMaximum: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/ws`, {
      headers: {
        Origin: 'https://evil.example',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('origin not allowed');
  });
});

describe('built-in TLS', () => {
  test('TLS_CERT and TLS_KEY serve wss:// that a client trusting the certificate can use', async () => {
    const certificate = await testCertificateCreate();
    const server = relayStart({ tlsCertificateFile: certificate.certificateFile, tlsKeyFile: certificate.keyFile });
    const health = await fetch(`https://127.0.0.1:${server.port}/healthz`, {
      tls: { ca: certificate.certificatePem },
    } as RequestInit);
    expect(await health.text()).toBe('ok\n');
    const outcome = await testSocketOutcome(`wss://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: TEST_ORIGIN },
      certificateAuthority: certificate.certificatePem,
      closeWhenOpen: true,
    });
    expect([outcome.opened, outcome.code]).toEqual([true, 1000]);
    certificate.remove();
  });

  test('a missing certificate file fails at startup with the path in the error', () => {
    expect(() =>
      collabServerStart(
        testConfiguration({ tlsCertificateFile: '/nonexistent/cert.pem', tlsKeyFile: '/nonexistent/key.pem' }),
      ),
    ).toThrow('/nonexistent/');
  });
});
