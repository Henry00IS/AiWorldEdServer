/**
 * Fake browser editor for browser MCP tests: a real relay connection that
 * agreed on `mcp`, listens on a token and answers forwarded requests.
 */
import { TestClient, type TestMessage } from './test_client.ts';

/** Capabilities of the fake editor. */
export const TEST_MCP_CAPS = ['select', 'mcp'];

/**
 * Creates a fresh token the way the editor does: 48 random bytes as base64url.
 *
 * @returns 64 character token.
 */
export function testMcpToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');
}

/**
 * Returns the browser MCP URL of a token on a local relay.
 *
 * @param port Relay port.
 * @param token Path rest after `/ws/mcp/`.
 * @returns URL.
 */
export function testMcpUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/ws/mcp/${token}`;
}

/**
 * Connects an editor with the `mcp` capability and makes it listen on a token.
 *
 * @param port Relay port.
 * @param token Token to listen on.
 * @returns Listening editor.
 */
export async function testMcpEditorListen(port: number, token: string): Promise<TestClient> {
  const editor = await TestClient.connect(port, { caps: TEST_MCP_CAPS });
  const reply = await editor.request({ t: 'mcp.listen', token }, 'mcp.listening');
  if (reply.t !== 'mcp.listening') throw new Error(`listen refused: ${JSON.stringify(reply)}`);
  return editor;
}

/**
 * Waits for the next forwarded request and answers it.
 *
 * @param editor Listening editor.
 * @param answer Builds the raw response text from the raw request text.
 * @param timeoutMs How long to wait for the request.
 * @returns The forwarded request message.
 */
export async function testMcpAnswerNext(
  editor: TestClient,
  answer: (body: string) => string,
  timeoutMs = 3000,
): Promise<TestMessage> {
  const request = await editor.next('mcp.request', () => true, timeoutMs);
  editor.send({ t: 'mcp.response', q: request.q, body: answer(request.body) });
  return request;
}

/**
 * POSTs a JSON-RPC text to a URL.
 *
 * @param url Browser MCP URL.
 * @param body Raw request text.
 * @returns Response.
 */
export function testMcpPost(url: string, body: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}
