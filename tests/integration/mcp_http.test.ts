/**
 * Browser MCP end to end: an editor listens on a token over its relay
 * connection, JSON-RPC POSTs to `/ws/mcp/<token>` reach it verbatim and its
 * answers come back; every bad or idle token gets the same plain 404; one
 * connection per token; and `GET`/`OPTIONS` behave like the desktop server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { collabServerStart, type CollabServer } from '../../src/server/server_collab.ts';
import { CLOSE_CODES } from '../../src/shared/protocol_definitions.ts';
import { TestClient } from '../support/test_client.ts';
import { testConfiguration } from '../support/test_configuration.ts';
import {
  TEST_MCP_CAPS,
  testMcpAnswerNext,
  testMcpEditorListen,
  testMcpPost,
  testMcpToken,
  testMcpUrl,
} from '../support/test_mcp_editor.ts';

let server: CollabServer;
const clients: TestClient[] = [];

beforeAll(() => {
  server = collabServerStart(testConfiguration({ connectionsPerIp: 200 }));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Bun.sleep(30);
});

afterAll(async () => {
  await server.stop();
});

/**
 * Connects a tracked editor listening on a token.
 *
 * @param token Token.
 * @returns Listening editor.
 */
async function editorListen(token: string): Promise<TestClient> {
  const editor = await testMcpEditorListen(server.port, token);
  clients.push(editor);
  return editor;
}

/**
 * Fetches a path of the relay and reads status and text.
 *
 * @param path Path after the host.
 * @returns Status and body text.
 */
async function plainGet(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST', body: '{}' });
  return { status: response.status, text: await response.text() };
}

describe('forwarding', () => {
  test('a POST reaches the listening editor verbatim and its JSON answer comes back', async () => {
    const token = testMcpToken();
    const editor = await editorListen(token);
    const requestText = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}';
    const pending = testMcpPost(testMcpUrl(server.port, token), requestText);
    const forwarded = await testMcpAnswerNext(editor, () => '{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}');
    const response = await pending;
    expect(forwarded.body).toBe(requestText);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  });

  test('an empty answer is a notification: 202 without a body', async () => {
    const token = testMcpToken();
    const editor = await editorListen(token);
    const pending = testMcpPost(testMcpUrl(server.port, token), '{"jsonrpc":"2.0","method":"notifications/x"}');
    await testMcpAnswerNext(editor, () => '');
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  test('GET gives the desktop hint and OPTIONS the CORS preflight', async () => {
    const token = testMcpToken();
    await editorListen(token);
    const hint = await fetch(testMcpUrl(server.port, token));
    expect(await hint.json()).toEqual({ ok: true, message: 'AiWorldEd MCP endpoint. Use POST for JSON-RPC.' });
    const preflight = await fetch(testMcpUrl(server.port, token), { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect((await fetch(testMcpUrl(server.port, token), { method: 'PUT' })).status).toBe(405);
  });

  test('the relay announces the mcp capability to editors that ask for it', async () => {
    const editor = await TestClient.connect(server.port, { caps: TEST_MCP_CAPS });
    const older = await TestClient.connect(server.port);
    clients.push(editor, older);
    expect(editor.welcome.caps).toContain('mcp');
    expect(older.welcome.caps).not.toContain('mcp');
  });
});

describe('tokens', () => {
  test('malformed, unknown and idle tokens all get the same plain 404 as any unknown path', async () => {
    const token = testMcpToken();
    await editorListen(token);
    const reference = await plainGet('/no-such-path');
    const bad = [testMcpToken(), token.slice(1), `${token}A`, `${token.slice(1)}!`, `${token}/x`, `${token}/`];
    bad.push(`${token.slice(3)}%41%41%41`, `${token.slice(1)}.`, '', `../mcp/${token}`.slice(0, 64));
    for (const candidate of bad) expect(await plainGet(`/ws/mcp/${candidate}`)).toEqual(reference);
    expect(reference).toEqual({ status: 404, text: 'not found\n' });
  });

  test('a token stops answering once its editor unlistens or disconnects', async () => {
    const token = testMcpToken();
    const editor = await editorListen(token);
    editor.send({ t: 'mcp.unlisten' });
    await Bun.sleep(50);
    expect((await fetch(testMcpUrl(server.port, token))).status).toBe(404);
    const again = await editorListen(token);
    expect((await fetch(testMcpUrl(server.port, token))).status).toBe(200);
    again.close();
    await again.closed();
    await Bun.sleep(50);
    expect((await fetch(testMcpUrl(server.port, token))).status).toBe(404);
  });

  test('one connection per token: a second listener gets mcp_token_in_use until the first leaves', async () => {
    const token = testMcpToken();
    const first = await editorListen(token);
    const second = await TestClient.connect(server.port, { caps: TEST_MCP_CAPS });
    clients.push(second);
    const refused = await second.request({ t: 'mcp.listen', token }, 'mcp.listening');
    expect(refused).toMatchObject({ t: 'error', code: 'mcp_token_in_use' });
    expect((await first.request({ t: 'mcp.listen', token }, 'mcp.listening')).t).toBe('mcp.listening');
    first.close();
    await first.closed();
    await Bun.sleep(50);
    expect((await second.request({ t: 'mcp.listen', token }, 'mcp.listening')).t).toBe('mcp.listening');
  });

  test('listening without the capability or with a malformed token closes the connection', async () => {
    const plain = await TestClient.connect(server.port);
    const malformed = await TestClient.connect(server.port, { caps: TEST_MCP_CAPS });
    clients.push(plain, malformed);
    plain.send({ t: 'mcp.listen', token: testMcpToken() });
    malformed.send({ t: 'mcp.listen', token: testMcpToken().slice(1) });
    expect(await plain.closed()).toBe(CLOSE_CODES.protocolViolation);
    expect(await malformed.closed()).toBe(CLOSE_CODES.protocolViolation);
  });
});
